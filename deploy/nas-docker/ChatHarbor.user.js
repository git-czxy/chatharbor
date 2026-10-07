// ==UserScript==
// @name         ChatHarbor
// @name:zh-CN   ChatHarbor
// @version      0.0.14.5.1
// @description  Local-first ChatGPT archive and integrity audit with incremental sync, attachment provenance, and transparent failure diagnostics.
// @description:zh-CN 本地优先的 ChatGPT 对话归档与完整性审计工具，支持增量同步、附件来源追踪和透明的失败诊断。
// @author       git-czxy
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @require      https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js
// @grant        none
// @license      MIT
// @namespace    https://github.com/git-czxy/chat-harbor
// @homepageURL  https://github.com/git-czxy/chat-harbor
// @supportURL   https://github.com/git-czxy/chat-harbor/issues
// @source       https://github.com/git-czxy/chat-harbor
// @downloadURL  https://raw.githubusercontent.com/git-czxy/chat-harbor/main/ChatHarbor.user.js
// @updateURL    https://raw.githubusercontent.com/git-czxy/chat-harbor/main/ChatHarbor.user.js
// ==/UserScript==

/*
 * Upstream attribution
 * Portions derived from huhusmang/ChatGPT-Exporter (MIT).
 * License and provenance details are documented in THIRD_PARTY_NOTICES.md.
 */

(function () {
    'use strict';

    // --- 配置与全局变量 ---
    const BASE_DELAY = 600;
    const JITTER = 400;
    const PAGE_LIMIT = 100;
    const PROJECT_SIDEBAR_PREVIEW = 5;
    const PROJECT_SIDEBAR_LIMIT = 50;
    let accessToken = null;
    let capturedWorkspaceIds = new Set(); // 使用Set存储网络拦截到的ID，确保唯一性

    // --- 核心：网络拦截与信息捕获 ---
    (function interceptNetwork() {
        const rawFetch = window.fetch;
        window.fetch = async function (resource, options) {
            tryCaptureToken(options?.headers);
            if (options?.headers?.['ChatGPT-Account-Id']) {
                const id = options.headers['ChatGPT-Account-Id'];
                if (id && !capturedWorkspaceIds.has(id)) {
                    console.log('🎯 [Fetch] 捕获到 Workspace ID:', id);
                    capturedWorkspaceIds.add(id);
                }
            }
            return rawFetch.apply(this, arguments);
        };

        const rawOpen = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function () {
            this.addEventListener('readystatechange', () => {
                if (this.readyState === 4) {
                    try {
                        tryCaptureToken(this.getRequestHeader('Authorization'));
                        const id = this.getRequestHeader('ChatGPT-Account-Id');
                        if (id && !capturedWorkspaceIds.has(id)) {
                            console.log('🎯 [XHR] 捕获到 Workspace ID:', id);
                            capturedWorkspaceIds.add(id);
                        }
                    } catch (_) {}
                }
            });
            return rawOpen.apply(this, arguments);
        };
    })();

    function tryCaptureToken(header) {
        if (!header) return;
        const h = typeof header === 'string' ? header : header instanceof Headers ? header.get('Authorization') : header.Authorization || header.authorization;
        if (h?.startsWith('Bearer ')) {
        const token = h.slice(7);
        // Ignore the known dummy placeholder token.
        if (token && token.toLowerCase() !== 'dummy') {
            accessToken = token;
        }
        }
    }

    async function ensureAccessToken() {
        if (accessToken) return accessToken;
        try {
            const session = await (await fetch('/api/auth/session?unstable_client=true')).json();
            if (session.accessToken) {
                accessToken = session.accessToken;
                return accessToken;
            }
        } catch (_) {}
        alert('无法获取 Access Token。请刷新页面或打开任意一个对话后再试。');
        return null;
    }

    // --- 辅助函数 ---
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const jitter = () => BASE_DELAY + Math.random() * JITTER;
    const sanitizeFilename = (name) => name.replace(/[\/\\?%*:|"<>]/g, '-').trim();
    const normalizeEpochSeconds = (value) => {
        if (!value) return 0;
        if (typeof value === 'number' && Number.isFinite(value)) {
            return value > 1e12 ? Math.floor(value / 1000) : value;
        }
        if (typeof value === 'string') {
            const parsed = Date.parse(value);
            if (!Number.isNaN(parsed)) {
                return Math.floor(parsed / 1000);
            }
        }
        return 0;
    };
    const formatTimestamp = (value) => {
        const seconds = normalizeEpochSeconds(value);
        if (!seconds) return '';
        const date = new Date(seconds * 1000);
        return Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
    };
    const parseDateInputToEpoch = (value, isEnd = false) => {
        if (!value) return null;
        const parts = value.split('-').map(Number);
        if (parts.length !== 3 || parts.some(Number.isNaN)) return null;
        const [year, month, day] = parts;
        const date = isEnd
            ? new Date(year, month - 1, day, 23, 59, 59, 999)
            : new Date(year, month - 1, day, 0, 0, 0, 0);
        const epochMs = date.getTime();
        return Number.isNaN(epochMs) ? null : Math.floor(epochMs / 1000);
    };

    /**
     * 从 Cookie 获取 oai-device-id。
     * @returns {string|null} - 返回设备ID或null
     */
    function getOaiDeviceId() {
        const cookieString = document.cookie;
        const match = cookieString.match(/oai-did=([^;]+)/);
        return match ? match[1] : null;
    }

    function generateUniqueFilename(convData) {
        const convId = convData.conversation_id || '';
        const shortId = convId.includes('-') ? convId.split('-').pop() : (convId || Date.now().toString(36));
        let baseName = convData.title;
        if (!baseName || baseName.trim().toLowerCase() === 'new chat') {
            baseName = 'Untitled Conversation';
        }
        return `${sanitizeFilename(baseName)}_${shortId}.json`;
    }

    function generateMarkdownFilename(convData) {
        const jsonName = generateUniqueFilename(convData);
        return jsonName.endsWith('.json')
            ? `${jsonName.slice(0, -5)}.md`
            : `${jsonName}.md`;
    }

    const ATTACHMENT_EXPORT_VERSION = '0.0.14.5.1';
    const EXPORT_BUTTON_LABEL = 'ChatHarbor';
    const MIME_EXTENSIONS = {
        'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp',
        'application/pdf': '.pdf', 'application/zip': '.zip', 'application/json': '.json',
        'text/plain': '.txt', 'text/csv': '.csv',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx'
    };

    function safeAttachmentName(value) {
        let name = String(value || 'attachment');
        try { name = decodeURIComponent(name); } catch (_) {}
        name = name.split(/[\\/]/).pop() || 'attachment';
        return name
            .replace(/[\u0000-\u001f\u007f]/g, '')
            .replace(/[\\/:*?"<>|]/g, '-')
            .replace(/^[. ]+|[. ]+$/g, '')
            .slice(0, 180) || 'attachment';
    }

    function addMimeExtension(filename, mimeType) {
        if (/\.[a-z0-9]{1,10}$/i.test(filename)) return filename;
        const mime = String(mimeType || '').split(';')[0].trim().toLowerCase();
        return filename + (MIME_EXTENSIONS[mime] || '');
    }

    function uniqueAttachmentName(filename, usedNames) {
        const safe = safeAttachmentName(filename);
        if (!usedNames.has(safe)) {
            usedNames.add(safe);
            return safe;
        }
        const dot = safe.lastIndexOf('.');
        const base = dot > 0 ? safe.slice(0, dot) : safe;
        const extension = dot > 0 ? safe.slice(dot) : '';
        let index = 2;
        while (usedNames.has(`${base}_${index}${extension}`)) index++;
        const result = `${base}_${index}${extension}`;
        usedNames.add(result);
        return result;
    }

    function extractFileId(pointer) {
        if (typeof pointer !== 'string') return null;
        const match = pointer.match(/file[-_][a-z0-9]+/i);
        return match ? match[0] : null;
    }

    function getActiveConversationNodes(convData) {
        const mapping = convData?.mapping;
        if (!mapping || typeof mapping !== 'object') return [];

        const entries = Object.entries(mapping);
        if (entries.length === 0) return [];

        let currentNodeId = convData?.current_node;
        if (!currentNodeId || !mapping[currentNodeId]) {
            const leaves = entries
                .filter(([, node]) => !Array.isArray(node?.children) || node.children.length === 0)
                .sort(([, a], [, b]) => {
                    const aTime = Number(a?.message?.create_time) || 0;
                    const bTime = Number(b?.message?.create_time) || 0;
                    return bTime - aTime;
                });
            currentNodeId = leaves[0]?.[0] || entries[entries.length - 1][0];
            console.warn('Conversation current_node is unavailable; exporting the latest leaf path instead.');
        }

        const path = [];
        const visited = new Set();
        while (currentNodeId && !visited.has(currentNodeId)) {
            visited.add(currentNodeId);
            const node = mapping[currentNodeId];
            if (!node) break;
            path.push(node);
            currentNodeId = node.parent || null;
        }
        return path.reverse();
    }

    function collectVisibleAttachments(convData) {
        const references = new Map();
        const add = (reference) => {
            const key = reference.kind === 'sandbox'
                ? `sandbox:${reference.messageId}:${reference.sandboxPath}`
                : `file:${reference.fileId}`;
            if (!references.has(key)) references.set(key, reference);
        };

        getActiveConversationNodes(convData).forEach(node => {
            const message = node?.message;
            if (!message) return;
            const role = message.author?.role;
            if (role !== 'user' && role !== 'assistant' && role !== 'tool') return;
            if (message.metadata?.is_visually_hidden_from_conversation) return;

            if (role === 'user') {
                (message.metadata?.attachments || []).forEach(attachment => {
                    const fileId = attachment?.id || attachment?.file_id;
                    if (!fileId) return;
                    add({
                        kind: 'file', fileId, messageId: message.id,
                        ownerRole: role,
                        sourceCategory: 'user_upload',
                        name: attachment.name || fileId,
                        mimeType: attachment.mime_type || '',
                        isImage: /^image\//i.test(attachment.mime_type || '')
                    });
                });
            }

            (message.content?.parts || []).forEach(part => {
                if (part && typeof part === 'object' && part.asset_pointer && /image|canvas|audio|video/i.test(part.content_type || '')) {
                    const isGeneratedToolImage = role === 'tool' && Boolean(part.metadata?.dalle || part.metadata?.generation);
                    if (role === 'tool' && !isGeneratedToolImage) return;
                    const fileId = extractFileId(part.asset_pointer);
                    if (fileId) {
                        add({
                            kind: 'file', fileId, messageId: message.id,
                            ownerRole: role,
                            sourceCategory: role === 'user' ? 'user_upload' : (isGeneratedToolImage ? 'generated_media' : 'assistant_asset'),
                            name: isGeneratedToolImage ? 'generated_image' : (/image/i.test(part.content_type || '') ? 'image' : fileId),
                            mimeType: '', isImage: /image/i.test(part.content_type || '')
                        });
                    }
                }
                const text = typeof part === 'string' ? part : part?.text;
                if (role !== 'assistant' || typeof text !== 'string') return;
                for (const match of text.matchAll(/\]\((sandbox:[^)]+)\)/gi)) {
                    const sandboxPath = match[1];
                    add({
                        kind: 'sandbox', sandboxPath, messageId: message.id,
                        ownerRole: role,
                        sourceCategory: 'assistant_generated_deliverable',
                        name: sandboxPath.split('/').pop() || 'generated_file',
                        mimeType: '', isImage: /\.(?:png|jpe?g|gif|webp|svg)$/i.test(sandboxPath)
                    });
                }
            });
        });
        return Array.from(references.values());
    }

    function attachmentHeaders(workspaceId) {
        const headers = {
            'Authorization': `Bearer ${accessToken}`,
            'oai-device-id': getOaiDeviceId()
        };
        const resolvedWorkspaceId = resolveWorkspaceId(workspaceId);
        if (resolvedWorkspaceId) headers['ChatGPT-Account-Id'] = resolvedWorkspaceId;
        return headers;
    }

    async function fetchAttachmentBinary(reference, convData, workspaceId) {
        const headers = attachmentHeaders(workspaceId);
        let metadataUrl;
        if (reference.kind === 'sandbox') {
            const conversationId = convData?.conversation_id || convData?.id;
            if (!conversationId || !reference.messageId) throw new Error('missing conversation/message id');
            const query = new URLSearchParams({
                message_id: reference.messageId,
                sandbox_path: reference.sandboxPath.replace(/^sandbox:/i, '')
            });
            metadataUrl = `/backend-api/conversation/${encodeURIComponent(conversationId)}/interpreter/download?${query}`;
        } else {
            metadataUrl = `/backend-api/files/download/${encodeURIComponent(reference.fileId)}?inline=false`;
        }

        const metadataResponse = await chBackendFetch(metadataUrl, { credentials: 'include', headers });
        if (!metadataResponse.ok) throw new Error(`metadata HTTP ${metadataResponse.status}`);
        const contentType = metadataResponse.headers.get('content-type') || '';
        if (!contentType.includes('json')) {
            const directName = addMimeExtension(reference.name, contentType);
            return { data: new Uint8Array(await metadataResponse.arrayBuffer()), filename: directName };
        }

        const metadata = await metadataResponse.json();
        const downloadUrl = metadata.download_url || metadata.url;
        if (!downloadUrl) throw new Error('download_url missing or expired');
        const parsedUrl = new URL(downloadUrl, location.origin);
        const sameOrigin = parsedUrl.origin === location.origin;
        const response = await chDataTransferFetch(parsedUrl.href, sameOrigin
            ? { credentials: 'include', headers }
            : {});
        if (!response.ok) throw new Error(`binary HTTP ${response.status}`);
        const mimeType = response.headers.get('content-type') || reference.mimeType || '';
        const filename = addMimeExtension(
            safeAttachmentName(metadata.file_name || metadata.filename || reference.name),
            mimeType
        );
        return { data: new Uint8Array(await response.arrayBuffer()), filename };
    }

    function encodeRelativePath(path) {
        return path.split('/').map(segment => encodeURIComponent(segment)).join('/');
    }

    async function appendAttachmentsToZip(target, convData, workspaceId) {
        const references = collectVisibleAttachments(convData);
        const failures = [];
        const files = [];
        const sandboxPaths = new Map();
        const usedNames = new Set();
        const folderName = generateUniqueFilename(convData).replace(/\.json$/i, '') + '_files';

        for (const reference of references) {
            try {
                const downloaded = await fetchAttachmentBinary(reference, convData, workspaceId);
                const filename = uniqueAttachmentName(downloaded.filename, usedNames);
                target.folder(folderName).file(filename, downloaded.data);
                const relativePath = encodeRelativePath(`${folderName}/${filename}`);
                files.push({
                    name: filename,
                    path: relativePath,
                    kind: reference.kind,
                    isImage: reference.isImage,
                    messageId: reference.messageId,
                    ownerRole: reference.ownerRole,
                    sourceCategory: reference.sourceCategory || chAttachmentSourceCategory(reference.ownerRole, reference.kind, reference.isImage)
                });
                if (reference.kind === 'sandbox') {
                    sandboxPaths.set(`${reference.messageId}|${reference.sandboxPath}`, relativePath);
                }
            } catch (error) {
                failures.push({
                    kind: reference.kind,
                    file_id: reference.fileId || null,
                    sandbox_path: reference.sandboxPath || null,
                    message_id: reference.messageId || null,
                    name: reference.name,
                    owner_role: reference.ownerRole || null,
                    source_category: reference.sourceCategory || chAttachmentSourceCategory(reference.ownerRole, reference.kind, reference.isImage),
                    reference_kind: reference.kind || null,
                    error: error?.message || String(error)
                });
            }
            await sleep(150);
        }
        return { detected: references.length, files, failures, sandboxPaths };
    }

    function replaceDownloadedSandboxLinks(text, sandboxPaths, messageId) {
        if (!text || !sandboxPaths) return text;
        return text.replace(/\]\((sandbox:[^)]+)\)/gi, (match, sandboxPath) => {
            const localPath = sandboxPaths.get(`${messageId}|${sandboxPath}`);
            return localPath ? `](${localPath})` : match;
        });
    }


    function cleanMessageContent(text) {
        if (!text) return '';
        return text
            .replace(/\uE200cite(?:\uE202turn\d+(?:search|view)\d+)+\uE201/gi, '')
            .replace(/cite(?:turn\d+(?:search|view)\d+)+/gi, '')
            .trim();
    }

    function processContentReferences(text, contentReferences, referenceStartIndex = 1) {
        if (!text || !Array.isArray(contentReferences) || contentReferences.length === 0) {
            return { text, footnotes: [], nextReferenceIndex: referenceStartIndex };
        }

        const references = contentReferences.filter(ref => ref && typeof ref.matched_text === 'string' && ref.matched_text.length > 0);
        if (references.length === 0) {
            return { text, footnotes: [], nextReferenceIndex: referenceStartIndex };
        }

        const getReferenceInfo = (ref) => {
            const item = Array.isArray(ref.items) ? ref.items[0] : null;
            const url = item?.url || (Array.isArray(ref.safe_urls) ? ref.safe_urls[0] : '') || '';
            const title = item?.title || '';
            let label = item?.attribution || '';
            if (!label && typeof ref.alt === 'string') {
                const match = ref.alt.match(/\[([^\]]+)\]\([^)]+\)/);
                if (match) label = match[1];
            }
            if (!label) label = title || url;
            return { url, title, label };
        };

        const footnotes = [];
        const footnoteIndexByKey = new Map();
        const citationRefs = references
            .filter(ref => ref.type === 'grouped_webpages')
            .sort((a, b) => {
                const aIdx = Number.isFinite(a.start_idx) ? a.start_idx : Number.MAX_SAFE_INTEGER;
                const bIdx = Number.isFinite(b.start_idx) ? b.start_idx : Number.MAX_SAFE_INTEGER;
                return aIdx - bIdx;
            });

        citationRefs.forEach(ref => {
            const info = getReferenceInfo(ref);
            if (!info.url) return;
            const key = `${info.url}|${info.title}`;
            if (footnoteIndexByKey.has(key)) return;
            const index = referenceStartIndex + footnotes.length;
            footnoteIndexByKey.set(key, index);
            footnotes.push({ index, url: info.url, title: info.title, label: info.label });
        });

        const sortedByReplacement = references
            .slice()
            .sort((a, b) => {
                const aIdx = Number.isFinite(a.start_idx) ? a.start_idx : -1;
                const bIdx = Number.isFinite(b.start_idx) ? b.start_idx : -1;
                if (aIdx !== -1 || bIdx !== -1) {
                    return bIdx - aIdx;
                }
                return (b.matched_text?.length || 0) - (a.matched_text?.length || 0);
            });

        let output = text;
        sortedByReplacement.forEach(ref => {
            if (!ref?.matched_text || ref.type === 'sources_footnote') return;
            let replacement = '';
            if (ref.type === 'grouped_webpages') {
                const info = getReferenceInfo(ref);
                if (info.url) {
                    const key = `${info.url}|${info.title}`;
                    const index = footnoteIndexByKey.get(key);
                    replacement = index ? `([${info.label}][${index}])` : (ref.alt || '');
                } else {
                    replacement = ref.alt || '';
                }
            } else {
                replacement = ref.alt || '';
            }

            if (Number.isFinite(ref.start_idx) && Number.isFinite(ref.end_idx)) {
                if (output.slice(ref.start_idx, ref.end_idx) === ref.matched_text) {
                    output = output.slice(0, ref.start_idx) + replacement + output.slice(ref.end_idx);
                    return;
                }
            }
            output = output.split(ref.matched_text).join(replacement);
        });

        return {
            text: output,
            footnotes,
            nextReferenceIndex: referenceStartIndex + footnotes.length
        };
    }

    function extractConversationMessages(convData, attachmentResult = null) {
        const messages = [];
        const nodes = getActiveConversationNodes(convData);
        let nextReferenceIndex = 1;

        nodes.forEach(node => {
            const msg = node?.message;
            if (!msg) return;

            const author = msg.author?.role;
            const isHidden = msg.metadata?.is_visually_hidden_from_conversation ||
                msg.metadata?.is_contextual_answers_system_message;
            if ((author !== 'user' && author !== 'assistant') || isHidden) return;

            const content = msg.content;
            if ((content?.content_type !== 'text' && content?.content_type !== 'multimodal_text') || !Array.isArray(content.parts)) return;

            const rawText = content.parts
                .map(part => typeof part === 'string' ? part : (part?.text ?? ''))
                .filter(Boolean)
                .join('\n');
            const contentReferences = msg.metadata?.content_references || [];
            let processedText = rawText;
            let footnotes = [];
            if (Array.isArray(contentReferences) && contentReferences.length > 0) {
                const processed = processContentReferences(rawText, contentReferences, nextReferenceIndex);
                processedText = processed.text;
                footnotes = processed.footnotes;
                nextReferenceIndex = processed.nextReferenceIndex;
            }

            const cleaned = cleanMessageContent(
                replaceDownloadedSandboxLinks(processedText, attachmentResult?.sandboxPaths, msg.id)
            );
            const attachmentLines = (attachmentResult?.files || [])
                .filter(file => file.messageId === msg.id && file.kind !== 'sandbox')
                .map(file => {
                    const label = file.name.replace(/[\[\]]/g, '\\$&');
                    return file.isImage ? `![${label}](${file.path})` : `📎 [${label}](${file.path})`;
                });
            const renderedContent = [cleaned, ...attachmentLines].filter(Boolean).join('\n\n');
            if (!renderedContent) return;

            messages.push({
                role: author,
                content: renderedContent,
                messageId: msg.id,
                create_time: msg.create_time || null,
                footnotes
            });
        });

        return messages;
    }

    function convertConversationToMarkdown(convData, attachmentResult = null) {
        const messages = extractConversationMessages(convData, attachmentResult);
        const mdLines = messages.length === 0
            ? ['# Conversation', 'No visible user or assistant messages were exported.', '']
            : [];
        messages.forEach(msg => {
            const roleLabel = msg.role === 'user' ? '# User' : '# Assistant';
            mdLines.push(roleLabel);
            mdLines.push(msg.content);
            if (Array.isArray(msg.footnotes) && msg.footnotes.length > 0) {
                mdLines.push('');
                msg.footnotes
                    .slice()
                    .sort((a, b) => a.index - b.index)
                    .forEach(note => {
                        if (!note.url) return;
                        const title = note.title ? ` "${note.title}"` : '';
                        mdLines.push(`[${note.index}]: ${note.url}${title}`);
                    });
            }
            mdLines.push('');
        });

        const additionalFiles = (attachmentResult?.files || [])
            .filter(file => file.kind !== 'sandbox' && file.ownerRole !== 'user' && file.ownerRole !== 'assistant');
        if (additionalFiles.length > 0) {
            mdLines.push('# Attachments', '');
            additionalFiles.forEach(file => {
                const label = file.name.replace(/[\[\]]/g, '\\$&');
                mdLines.push(file.isImage ? `![${label}](${file.path})` : `- [${label}](${file.path})`);
            });
            mdLines.push('');
        }

        return mdLines.join('\n').trim() + '\n';
    }

    function downloadFile(blob, filename) {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(a.href);
    }

    // --- ChatHarbor 悬浮入口（可拖动、位置记忆、贴边半隐藏） ---
    const FAB_SIZE = 44;
    const FAB_DRAG_THRESHOLD = 6;
    const FAB_EDGE_SNAP = 36;
    const FAB_STORAGE_KEY = 'chatharbor-fab-v2';
    const FAB_ICON_SVG = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>';

    const fabState = { x: null, y: null, docked: null, collapsed: false };
    let fabDragInfo = null;
    let fabSuppressClick = false;
    let fabCollapseTimer = null;

    function fabDefaultPosition() {
        return { x: window.innerWidth - FAB_SIZE / 2 - 14, y: Math.round(window.innerHeight * 0.45) };
    }

    function fabClamp(pos) {
        const half = FAB_SIZE / 2;
        return {
            x: Math.min(Math.max(pos.x, half + 2), Math.max(half + 2, window.innerWidth - half - 2)),
            y: Math.min(Math.max(pos.y, half + 2), Math.max(half + 2, window.innerHeight - half - 2))
        };
    }

    function fabSnap(pos) {
        const half = FAB_SIZE / 2;
        const snapped = { ...pos };
        fabState.docked = null;
        if (pos.x <= half + FAB_EDGE_SNAP) {
            snapped.x = half + 2;
            fabState.docked = 'left';
        } else if (pos.x >= window.innerWidth - half - FAB_EDGE_SNAP) {
            snapped.x = window.innerWidth - half - 2;
            fabState.docked = 'right';
        }
        return snapped;
    }

    function loadFabState() {
        try {
            const saved = JSON.parse(localStorage.getItem(FAB_STORAGE_KEY));
            if (saved && typeof saved.x === 'number' && typeof saved.y === 'number') return saved;
        } catch (_) {}
        return null;
    }

    function saveFabState() {
        try {
            localStorage.setItem(FAB_STORAGE_KEY, JSON.stringify({
                x: fabState.x,
                y: fabState.y,
                docked: fabState.docked,
                collapsed: fabState.collapsed
            }));
        } catch (_) {}
    }

    function fabStatusEl() {
        let el = document.getElementById('gre-fab-status');
        if (!el) {
            el = document.createElement('div');
            el.id = 'gre-fab-status';
            document.body.appendChild(el);
        }
        return el;
    }

    function fabPositionStatus(btn) {
        const pill = document.getElementById('gre-fab-status');
        if (!pill) return;
        const rect = btn.getBoundingClientRect();
        const left = fabState.x > window.innerWidth / 2
            ? rect.left - pill.offsetWidth - 10
            : rect.right + 10;
        pill.style.left = `${Math.max(6, Math.min(left, window.innerWidth - pill.offsetWidth - 6))}px`;
        pill.style.top = `${Math.round(rect.top + rect.height / 2 - pill.offsetHeight / 2)}px`;
    }

    function fabApply(btn, pos, persist = false) {
        fabState.x = pos.x;
        fabState.y = pos.y;
        btn.style.left = `${Math.round(pos.x - FAB_SIZE / 2)}px`;
        btn.style.top = `${Math.round(pos.y - FAB_SIZE / 2)}px`;
        fabPositionStatus(btn);
        if (persist) saveFabState();
    }

    function fabIsCollapsed(btn) {
        return btn.classList.contains('gre-collapsed-left') || btn.classList.contains('gre-collapsed-right');
    }

    function fabExpand(btn) {
        btn.classList.remove('gre-collapsed-left', 'gre-collapsed-right');
        fabState.collapsed = false;
    }

    function fabCollapse(btn) {
        fabExpand(btn);
        if (!fabState.docked) return;
        btn.classList.add(`gre-collapsed-${fabState.docked}`);
        fabState.collapsed = true;
        saveFabState();
    }

    function fabScheduleCollapse(btn) {
        clearTimeout(fabCollapseTimer);
        if (!fabState.docked) return;
        fabCollapseTimer = setTimeout(() => {
            if (!btn.classList.contains('gre-busy') && !btn.classList.contains('gre-progress') && !btn.matches(':hover')) {
                fabCollapse(btn);
            }
        }, 1800);
    }

    function setFabStatus(btn, text) {
        btn.classList.remove('gre-busy', 'gre-progress', 'gre-done', 'gre-error');
        const ring = btn.querySelector('.gre-fab-ring');
        const badge = btn.querySelector('.gre-fab-badge');
        const pill = fabStatusEl();
        if (text === EXPORT_BUTTON_LABEL) {
            if (badge) badge.textContent = '';
            pill.classList.remove('gre-visible');
            btn.title = `ChatHarbor · 点击打开 · 拖动移动 · 右键重置位置`;
            fabScheduleCollapse(btn);
            return;
        }
        const progress = /\((\d+)\s*\/\s*(\d+)\)/.exec(text);
        if (progress && Number(progress[2]) > 0) {
            const pct = Math.min(100, Math.round((Number(progress[1]) / Number(progress[2])) * 100));
            btn.classList.add('gre-progress');
            if (ring) ring.style.setProperty('--gre-pct', String(pct));
            if (badge) badge.textContent = `${pct}%`;
        } else if (text.includes('✅')) {
            btn.classList.add('gre-done');
            if (badge) badge.textContent = '✓';
        } else if (text.includes('⚠️')) {
            btn.classList.add('gre-error');
            if (badge) badge.textContent = '!';
        } else {
            btn.classList.add('gre-busy');
            if (badge) badge.textContent = '';
        }
        btn.title = `${text} · ChatHarbor v${ATTACHMENT_EXPORT_VERSION}`;
        fabExpand(btn);
        pill.textContent = text;
        pill.classList.add('gre-visible');
        fabPositionStatus(btn);
    }

    function ensureFabStyle() {
        if (document.getElementById('gre-fab-style')) return;
        const style = document.createElement('style');
        style.id = 'gre-fab-style';
        style.textContent = `
#export-dialog-overlay input[type="checkbox"] {
    appearance: auto !important; -webkit-appearance: auto !important;
    width: 16px !important; height: 16px !important;
    min-width: 16px !important; min-height: 16px !important;
    flex-shrink: 0 !important; accent-color: #10a37f;
}
#export-dialog-overlay input[type="checkbox"]:focus-visible {
    outline: 2px solid #10a37f; outline-offset: 2px;
}

#gpt-rescue-btn {
    position: fixed;
    width: ${FAB_SIZE}px;
    height: ${FAB_SIZE}px;
    padding: 0;
    border-radius: 999px;
    border: 1px solid rgba(0, 0, 0, .08);
    background: #10a37f;
    color: #ffffff;
    -webkit-backdrop-filter: blur(10px);
    backdrop-filter: blur(10px);
    box-shadow: 0 2px 10px rgba(0, 0, 0, .16);
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: grab;
    z-index: 99997;
    user-select: none;
    -webkit-user-select: none;
    touch-action: none;
    font-family: ui-sans-serif, system-ui, -apple-system, sans-serif;
    transition: transform .25s ease, box-shadow .2s ease;
}
#gpt-rescue-btn:hover { background:#0d8f70; box-shadow: 0 4px 16px rgba(0, 0, 0, .24); }
#gpt-rescue-btn.gre-dragging { transition: none; cursor: grabbing; }
#gpt-rescue-btn:disabled { cursor: default; }
#gpt-rescue-btn:focus-visible { outline: 2px solid #10a37f; outline-offset: 2px; }

html.dark #gpt-rescue-btn {
    background: #10a37f;
    border-color: rgba(255, 255, 255, .22);
    color: #ffffff;
}

.gre-fab-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    transition: opacity .2s;
}
.gre-fab-ring {
    position: absolute;
    inset: 2px;
    border-radius: 999px;
    opacity: 0;
    background: conic-gradient(#10a37f calc(var(--gre-pct, 0) * 1%), rgba(0, 0, 0, .12) 0);
    -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 3.5px), #000 calc(100% - 3px));
    mask: radial-gradient(farthest-side, transparent calc(100% - 3.5px), #000 calc(100% - 3px));
    transition: opacity .2s;
}
html.dark .gre-fab-ring {
    background: conic-gradient(#19c37d calc(var(--gre-pct, 0) * 1%), rgba(255, 255, 255, .16) 0);
}
.gre-fab-badge {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: -.2px;
    opacity: 0;
    transition: opacity .2s;
}
#gpt-rescue-btn.gre-progress .gre-fab-ring,
#gpt-rescue-btn.gre-progress .gre-fab-badge { opacity: 1; }
#gpt-rescue-btn.gre-progress .gre-fab-icon { opacity: 0; }
#gpt-rescue-btn.gre-busy .gre-fab-icon { opacity: 0; animation: gre-pulse 1.1s ease-in-out infinite; }
#gpt-rescue-btn.gre-done { color: #10a37f; }
#gpt-rescue-btn.gre-error { color: #ef4444; }
#gpt-rescue-btn.gre-done .gre-fab-icon,
#gpt-rescue-btn.gre-error .gre-fab-icon { opacity: 0; }
#gpt-rescue-btn.gre-done .gre-fab-badge,
#gpt-rescue-btn.gre-error .gre-fab-badge { opacity: 1; }

#gpt-rescue-btn.gre-collapsed-right { transform: translateX(58%); }
#gpt-rescue-btn.gre-collapsed-left { transform: translateX(-58%); }
#gpt-rescue-btn.gre-collapsed-right:hover,
#gpt-rescue-btn.gre-collapsed-left:hover,
#gpt-rescue-btn.gre-collapsed-right:focus-visible,
#gpt-rescue-btn.gre-collapsed-left:focus-visible,
#gpt-rescue-btn.gre-busy,
#gpt-rescue-btn.gre-progress,
#gpt-rescue-btn.gre-dragging { transform: none; }

@keyframes gre-pulse {
    0%, 100% { opacity: 0; }
    50% { opacity: 1; }
}

#gre-fab-status {
    position: fixed;
    z-index: 99997;
    max-width: 220px;
    padding: 5px 11px;
    border-radius: 999px;
    border: 1px solid rgba(0, 0, 0, .08);
    background: rgba(255, 255, 255, .92);
    color: #0d0d0d;
    -webkit-backdrop-filter: blur(10px);
    backdrop-filter: blur(10px);
    box-shadow: 0 2px 10px rgba(0, 0, 0, .14);
    font-size: 12px;
    font-weight: 500;
    line-height: 1.3;
    font-family: ui-sans-serif, system-ui, -apple-system, sans-serif;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    opacity: 0;
    pointer-events: none;
    transition: opacity .2s;
}
#gre-fab-status.gre-visible { opacity: 1; }
html.dark #gre-fab-status {
    background: rgba(52, 53, 65, .94);
    border-color: rgba(255, 255, 255, .14);
    color: #ececec;
}
`;
        document.head.appendChild(style);
    }

    function createFabButton() {
        let btn = document.getElementById('gpt-rescue-btn');
        if (!btn) {
            btn = document.createElement('button');
            btn.id = 'gpt-rescue-btn';
            btn.type = 'button';
            document.body.appendChild(btn);
        }
        // 旧版为文字按钮：清掉遗留的内联样式与文案，重建悬浮球结构
        if (!btn.querySelector('.gre-fab-ring')) {
            btn.textContent = '';
            btn.removeAttribute('style');
            btn.setAttribute('aria-label', 'ChatHarbor：本地归档同步');
            btn.innerHTML = `<span class="gre-fab-ring"></span><span class="gre-fab-icon">${FAB_ICON_SVG}</span><span class="gre-fab-badge"></span>`;
        }
        return btn;
    }

    function bindFabEvents(btn) {
        if (btn.dataset.fabBound === '1') return;
        btn.dataset.fabBound = '1';

        btn.addEventListener('pointerdown', (e) => {
            if (e.button !== 0 || btn.disabled) return;
            fabDragInfo = {
                id: e.pointerId,
                startX: e.clientX,
                startY: e.clientY,
                originX: fabState.x,
                originY: fabState.y,
                moved: false
            };
            try { btn.setPointerCapture(e.pointerId); } catch (_) {}
        });

        btn.addEventListener('pointermove', (e) => {
            if (!fabDragInfo || e.pointerId !== fabDragInfo.id) return;
            const dx = e.clientX - fabDragInfo.startX;
            const dy = e.clientY - fabDragInfo.startY;
            if (!fabDragInfo.moved) {
                if (Math.hypot(dx, dy) < FAB_DRAG_THRESHOLD) return;
                fabDragInfo.moved = true;
                btn.classList.add('gre-dragging');
                fabExpand(btn);
                document.getElementById('gre-fab-status')?.classList.remove('gre-visible');
            }
            fabApply(btn, fabClamp({ x: fabDragInfo.originX + dx, y: fabDragInfo.originY + dy }));
        });

        const endDrag = (e) => {
            if (!fabDragInfo || (e && e.pointerId !== fabDragInfo.id)) return;
            const wasMoved = fabDragInfo.moved;
            fabDragInfo = null;
            btn.classList.remove('gre-dragging');
            if (!wasMoved) return;
            fabSuppressClick = true;
            setTimeout(() => { fabSuppressClick = false; }, 100);
            fabApply(btn, fabSnap(fabClamp({ x: fabState.x, y: fabState.y })), true);
            fabScheduleCollapse(btn);
        };
        btn.addEventListener('pointerup', endDrag);
        btn.addEventListener('pointercancel', endDrag);

        btn.addEventListener('pointerenter', () => {
            clearTimeout(fabCollapseTimer);
            if (fabIsCollapsed(btn)) fabExpand(btn);
        });
        btn.addEventListener('pointerleave', () => fabScheduleCollapse(btn));

        btn.addEventListener('click', (e) => {
            if (fabSuppressClick) {
                fabSuppressClick = false;
                e.preventDefault();
                e.stopPropagation();
                return;
            }
            // 触屏无 hover：收起状态下第一次点按仅展开
            if (fabIsCollapsed(btn)) {
                fabExpand(btn);
                fabScheduleCollapse(btn);
                return;
            }
            if (btn.classList.contains('gre-busy') || btn.classList.contains('gre-progress')) return;
            showConversationPicker({ mode: 'personal', workspaceId: null, includeAttachments: false });
        });

        btn.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            fabExpand(btn);
            fabApply(btn, fabSnap(fabClamp(fabDefaultPosition())), true);
            const pill = fabStatusEl();
            pill.textContent = '已重置位置';
            pill.classList.add('gre-visible');
            fabPositionStatus(btn);
            setTimeout(() => {
                if (pill.textContent === '已重置位置') pill.classList.remove('gre-visible');
            }, 1500);
        });

        window.addEventListener('resize', () => {
            if (!document.body.contains(btn)) return;
            fabApply(btn, fabSnap(fabClamp({ x: fabState.x, y: fabState.y })), true);
        });
    }

    function getExportButton() {
        ensureFabStyle();
        const btn = createFabButton();
        bindFabEvents(btn);
        if (fabState.x == null) {
            const saved = loadFabState();
            fabApply(btn, fabSnap(fabClamp(saved ? { x: saved.x, y: saved.y } : fabDefaultPosition())));
            if ((saved && saved.collapsed && fabState.docked) || (!saved && fabState.docked)) fabCollapse(btn);
        }
        if (!btn.disabled) setFabStatus(btn, EXPORT_BUTTON_LABEL);
        btn.dataset.chatharborVersion = ATTACHMENT_EXPORT_VERSION;
        return btn;
    }

    function initFab() {
        if (!document.body) {
            setTimeout(initFab, 200);
            return;
        }
        getExportButton();
    }

    // --- 对话内容与附件处理基础能力 ---

    async function addConversationToZip(target, convData, workspaceId, report = null) {
        target.file(generateUniqueFilename(convData), JSON.stringify(convData, null, 2));
        if (!report) {
            target.file(generateMarkdownFilename(convData), convertConversationToMarkdown(convData));
            return;
        }
        const attachmentResult = await appendAttachmentsToZip(target, convData, workspaceId);
        target.file(generateMarkdownFilename(convData), convertConversationToMarkdown(convData, attachmentResult));
        report.detected += attachmentResult.detected;
        report.downloaded += attachmentResult.files.length;
        report.failed += attachmentResult.failures.length;
        report.conversations.push({
            conversation_id: convData?.conversation_id || null,
            title: convData?.title || 'Untitled Conversation',
            detected: attachmentResult.detected,
            downloaded: attachmentResult.files,
            failures: attachmentResult.failures
        });
    }


    // ======================== Archive Writer: Manifest + Identity ========================
    // Core archive-writer invariants:
    // - direct directory writing
    // - conversation_id as canonical archive identity
    // - per-conversation manifest commits
    // - content signature recording for version-aware comparison
    // - visible progress feedback
    //
    // Archive Layout v2 owns physical paths. Archive Scan, Planner, classification and
    // selective transaction logic remain separate layers.

    const CH_MANIFEST_NAME = 'ChatHarbor_manifest.json';
    const CH_MANIFEST_SCHEMA_VERSION = 1;
    const CH_SIGNATURE_VERSION = 'sha256-current_node+mapping-v1';
    const CH_UI_LANG = /^zh(?:-|$)/i.test(String(navigator.language || '')) ? 'zh-CN' : 'en-US';
    const chT = (zh, en) => CH_UI_LANG === 'zh-CN' ? zh : en;
    const CH_PRODUCT_VERSION = '0.0.14.5.1';
    const CH_PROVIDER = 'chatgpt';
    const CH_PROVIDER_LABEL = 'ChatGPT';
    const CH_ARCHIVE_LAYOUT_VERSION = 2;
    const CH_LAYOUT_CONVERSATIONS_DIR = 'conversations';
    const CH_LAYOUT_PROJECTS_DIR = 'projects';
    const CH_REMOTE_CACHE_DB = 'chatharbor-remote-index-v1';
    const CH_REMOTE_CACHE_STORE = 'snapshots';
    const CH_REMOTE_CACHE_SCHEMA = 1;
    const CH_REMOTE_HEAD_LIMIT = 20;
    const CH_REMOTE_FULL_REFRESH_MS = 24 * 60 * 60 * 1000;
    const CH_REMOTE_SYNC_FRESH_MS = 2 * 60 * 1000;
    const CH_DIRECTORY_HANDLE_DB = 'chatharbor-directory-handle-v1';
    const CH_DIRECTORY_HANDLE_STORE = 'handles';
    const CH_DIRECTORY_HANDLE_KEY = 'chatgpt-default';

    async function chOpenDirectoryHandleDb() {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(CH_DIRECTORY_HANDLE_DB, 1);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains(CH_DIRECTORY_HANDLE_STORE)) db.createObjectStore(CH_DIRECTORY_HANDLE_STORE);
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error || new Error('directory handle db open failed'));
        });
    }
    async function chDirectoryHandleLoad() {
        try {
            const db = await chOpenDirectoryHandleDb();
            return await new Promise(resolve => {
                const req = db.transaction(CH_DIRECTORY_HANDLE_STORE, 'readonly').objectStore(CH_DIRECTORY_HANDLE_STORE).get(CH_DIRECTORY_HANDLE_KEY);
                req.onsuccess = () => resolve(req.result || null);
                req.onerror = () => resolve(null);
            });
        } catch (_) { return null; }
    }
    async function chDirectoryHandleSave(handle) {
        try {
            const db = await chOpenDirectoryHandleDb();
            await new Promise((resolve, reject) => {
                const tx = db.transaction(CH_DIRECTORY_HANDLE_STORE, 'readwrite');
                tx.objectStore(CH_DIRECTORY_HANDLE_STORE).put(handle, CH_DIRECTORY_HANDLE_KEY);
                tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
            });
        } catch (_) {}
    }
    async function chDirectoryHandlePermission(handle, request = false) {
        if (!handle) return 'denied';
        try {
            let permission = await handle.queryPermission({ mode:'readwrite' });
            if (permission !== 'granted' && request && handle.requestPermission) permission = await handle.requestPermission({ mode:'readwrite' });
            return permission;
        } catch (_) { return 'denied'; }
    }


    // ======================== ChatHarbor Conservative Network Policy ========================
    // Clean reimplementation of the historical ChatHarbor conservative behavior contract.
    const CH_NETWORK_POLICY_KEY = 'chatharbor_network_policy_v2';
    const CH_SPEED_LEVELS = [
        { name: '少量任务（较快）', base: 4000, jitter: 3000, batchSize: 15, pauseMinSec: 60, pauseMaxSec: 90 },
        { name: '日常使用（平衡）', base: 8000, jitter: 4000, batchSize: 12, pauseMinSec: 90, pauseMaxSec: 120 },
        { name: '大量任务（更稳）', base: 12000, jitter: 6000, batchSize: 10, pauseMinSec: 120, pauseMaxSec: 180 },
        { name: '保守模式（最稳）', base: 18000, jitter: 7000, batchSize: 8, pauseMinSec: 180, pauseMaxSec: 300 }
    ];
    const CH_DEFAULT_NETWORK_POLICY = Object.freeze({
        speedIndex: 2,
        batchSize: 10,
        batchPauseMinSec: 120,
        batchPauseMaxSec: 180,
        maxRetries: 2
    });

    function chNormalizeNetworkPolicy(value = {}) {
        const rawSpeed = Number(value.speedIndex);
        const speedIndex = Number.isFinite(rawSpeed)
            ? Math.max(0, Math.min(CH_SPEED_LEVELS.length - 1, Math.trunc(rawSpeed)))
            : CH_DEFAULT_NETWORK_POLICY.speedIndex;
        const rawBatch = Number(value.batchSize);
        const batchSize = Number.isFinite(rawBatch)
            ? Math.max(1, Math.min(200, Math.trunc(rawBatch)))
            : CH_DEFAULT_NETWORK_POLICY.batchSize;
        const rawMin = Number(value.batchPauseMinSec);
        const rawMax = Number(value.batchPauseMaxSec);
        const minSec = Number.isFinite(rawMin)
            ? Math.max(0, Math.min(3600, Math.trunc(rawMin)))
            : CH_DEFAULT_NETWORK_POLICY.batchPauseMinSec;
        const maxCandidate = Number.isFinite(rawMax)
            ? Math.max(0, Math.min(3600, Math.trunc(rawMax)))
            : CH_DEFAULT_NETWORK_POLICY.batchPauseMaxSec;
        const rawRetries = Number(value.maxRetries);
        const maxRetries = Number.isFinite(rawRetries)
            ? Math.max(0, Math.min(5, Math.trunc(rawRetries)))
            : CH_DEFAULT_NETWORK_POLICY.maxRetries;
        return {
            speedIndex,
            batchSize,
            batchPauseMinSec: minSec,
            batchPauseMaxSec: Math.max(minSec, maxCandidate),
            maxRetries
        };
    }

    function chLoadNetworkPolicy() {
        try {
            const raw = localStorage.getItem(CH_NETWORK_POLICY_KEY);
            return chNormalizeNetworkPolicy(raw ? JSON.parse(raw) : CH_DEFAULT_NETWORK_POLICY);
        } catch (_) {
            return { ...CH_DEFAULT_NETWORK_POLICY };
        }
    }

    function chSaveNetworkPolicy(policy) {
        const normalized = chNormalizeNetworkPolicy(policy);
        try { localStorage.setItem(CH_NETWORK_POLICY_KEY, JSON.stringify(normalized)); } catch (_) {}
        return normalized;
    }

    function chNetworkDelayMs(policy) {
        const p = chNormalizeNetworkPolicy(policy);
        const speed = CH_SPEED_LEVELS[p.speedIndex];
        return speed.base + Math.random() * speed.jitter;
    }

    function chNetworkBatchPauseMs(policy) {
        const p = chNormalizeNetworkPolicy(policy);
        const span = p.batchPauseMaxSec - p.batchPauseMinSec;
        return Math.round((p.batchPauseMinSec + Math.random() * span) * 1000);
    }

    function chNetworkPolicySummary(policy) {
        const p = chNormalizeNetworkPolicy(policy);
        return CH_SPEED_LEVELS[p.speedIndex].name;
    }

    function chNetworkPolicyDetail(policy) {
        const p = chNormalizeNetworkPolicy(policy);
        const speed = CH_SPEED_LEVELS[p.speedIndex];
        const minSec = Math.round(speed.base / 1000);
        const maxSec = Math.round((speed.base + speed.jitter) / 1000);
        return `对话间隔 ${minSec}–${maxSec} 秒 · 每 ${p.batchSize} 条休息 ${p.batchPauseMinSec}–${p.batchPauseMaxSec} 秒`;
    }

    // ======================== Shared ChatHarbor Backend Scheduler ========================
    // One scheduler owns serialization, global HTTP 429 cooldown and retry classification,
    // but request lanes keep different cadences. Discovery must remain responsive; expensive
    // conversation detail remains conservative; attachment metadata is rate-limited without
    // inheriting the full detail delay. Signed/direct binary transfers remain a separate path.
    const chRawChatHarborFetch = window.fetch.bind(window);
    const CH_BACKEND_LANE_DISCOVERY = 'discovery';
    const CH_BACKEND_LANE_DETAIL = 'detail';
    const CH_BACKEND_LANE_ATTACHMENT = 'attachment';
    const CH_DISCOVERY_BASE_MS = 1000;
    const CH_DISCOVERY_JITTER_MS = 500;
    const CH_ATTACHMENT_META_BASE_MS = 3000;
    const CH_ATTACHMENT_META_JITTER_MS = 2000;
    const CH_ATTACHMENT_META_BATCH_SIZE = 10;
    const CH_ATTACHMENT_META_PAUSE_MIN_MS = 30000;
    const CH_ATTACHMENT_META_PAUSE_JITTER_MS = 30000;
    const chBackendScheduler = {
        tail: Promise.resolve(),
        cooldownUntil: 0,
        cooldownReason: null,
        rateLimitLevel: 0,
        laneNextAllowedAt: {
            discovery: 0,
            detail: 0,
            attachment: 0
        },
        laneRequestCount: {
            discovery: 0,
            detail: 0,
            attachment: 0
        }
    };
    let chNetworkStatusHook = null;
    const chBackendContext = { detailTitle: null, detailId: null, attachmentName: null };

    function chSetNetworkStatusHook(fn) {
        chNetworkStatusHook = typeof fn === 'function' ? fn : null;
    }

    function chEmitNetworkStatus(info = null) {
        try { if (chNetworkStatusHook) chNetworkStatusHook(info); } catch (_) {}
    }

    function chIsBackendControlUrl(resource) {
        try {
            const url = resource instanceof Request ? resource.url : String(resource || '');
            const parsed = new URL(url, location.origin);
            return parsed.origin === location.origin && parsed.pathname.startsWith('/backend-api/');
        } catch (_) {
            return false;
        }
    }

    function chBackendLaneFor(resource) {
        try {
            const url = resource instanceof Request ? resource.url : String(resource || '');
            const parsed = new URL(url, location.origin);
            const path = parsed.pathname;
            if (/^\/backend-api\/conversations\/?$/i.test(path)) return CH_BACKEND_LANE_DISCOVERY;
            if (/^\/backend-api\/gizmos(?:\/|$)/i.test(path)) return CH_BACKEND_LANE_DISCOVERY;
            if (/^\/backend-api\/files\/download\//i.test(path)) return CH_BACKEND_LANE_ATTACHMENT;
            if (/\/interpreter\/download$/i.test(path)) return CH_BACKEND_LANE_ATTACHMENT;
            if (/^\/backend-api\/conversation\/[^/]+\/?$/i.test(path)) return CH_BACKEND_LANE_DETAIL;
            return CH_BACKEND_LANE_DETAIL;
        } catch (_) {
            return CH_BACKEND_LANE_DETAIL;
        }
    }

    function chBackendPolicy() {
        return chNormalizeNetworkPolicy(chSyncRun?.active ? chSyncRun.policy : chLoadNetworkPolicy());
    }

    function chBackendRequestDescriptor(resource, lane = null) {
        try {
            const url = resource instanceof Request ? resource.url : String(resource || '');
            const parsed = new URL(url, location.origin);
            const path = parsed.pathname;
            const resolvedLane = lane || chBackendLaneFor(resource);
            if (/^\/backend-api\/conversations\/?$/i.test(path)) return '云端对话';
            if (/^\/backend-api\/gizmos\/snorlax\/sidebar/i.test(path)) return '项目对话';
            const projectMatch = path.match(/^\/backend-api\/gizmos\/([^/]+)\/conversations/i);
            if (projectMatch) return `项目对话 · ${projectMatch[1].slice(0, 18)}`;
            if (resolvedLane === CH_BACKEND_LANE_ATTACHMENT) {
                const label = chBackendContext.attachmentName;
                if (label) return `附件 · ${String(label).slice(0, 52)}`;
                const fileMatch = path.match(/^\/backend-api\/files\/download\/([^/]+)/i);
                if (fileMatch) return `附件 · ${fileMatch[1].slice(0, 28)}`;
                return '附件信息';
            }
            if (resolvedLane === CH_BACKEND_LANE_DETAIL) {
                const label = chBackendContext.detailTitle;
                if (label) return `对话 · ${String(label).slice(0, 52)}`;
                const detailMatch = path.match(/^\/backend-api\/conversation\/([^/]+)/i);
                if (detailMatch) return `对话 · ${detailMatch[1].slice(0, 18)}`;
                return '对话内容';
            }
            return 'ChatGPT 请求';
        } catch (_) {
            return lane === CH_BACKEND_LANE_DISCOVERY ? '云端对话' : lane === CH_BACKEND_LANE_ATTACHMENT ? '附件信息' : '对话内容';
        }
    }

    function chRetryDelayForFailure({ status = null, lane = CH_BACKEND_LANE_DETAIL, attempt = 1, binary = false } = {}) {
        const n = Math.max(1, Number(attempt) || 1);
        if (status === 429) return 300000 * n;
        if (status === 401 || status === 403 || status === 404) return null;
        if (status != null && !(status >= 500 && status <= 599)) return null;
        if (binary) return 10000 * n;
        if (lane === CH_BACKEND_LANE_DISCOVERY) return 5000 * n;
        if (lane === CH_BACKEND_LANE_ATTACHMENT) return 5000 * n;
        return 15000 * n;
    }

    function chRetryPrimary(status, binary = false) {
        if (status === 429) return '请求过多，暂时休息';
        if (status >= 500 && status <= 599) return `服务器暂时出错（${status}）`;
        return binary ? '附件下载网络异常' : '网络连接异常';
    }

    function chLaneDelayMs(lane, policy) {
        if (lane === CH_BACKEND_LANE_DISCOVERY) {
            return CH_DISCOVERY_BASE_MS + Math.random() * CH_DISCOVERY_JITTER_MS;
        }
        const factor = 1 + 0.5 * Math.max(0, Number(chBackendScheduler.rateLimitLevel || 0));
        if (lane === CH_BACKEND_LANE_ATTACHMENT) {
            return (CH_ATTACHMENT_META_BASE_MS + Math.random() * CH_ATTACHMENT_META_JITTER_MS) * factor;
        }
        return chNetworkDelayMs(policy) * factor;
    }

    function chRegisterRateLimit() {
        chBackendScheduler.rateLimitLevel = Math.min(4, Number(chBackendScheduler.rateLimitLevel || 0) + 1);
    }

    async function chSchedulerSleep(ms, primary = '', secondary = '', countdown = false) {
        const duration = Math.max(0, Math.round(Number(ms) || 0));
        if (!duration) return;
        if (chSyncRun?.active) {
            return chControlledSleep(duration, primary || '保守网络等待', secondary, { countdown });
        }
        const deadline = Date.now() + duration;
        while (Date.now() < deadline) {
            const remaining = Math.max(0, deadline - Date.now());
            chEmitNetworkStatus({ primary, secondary, countdown, remainingMs: remaining });
            await sleep(Math.min(1000, Math.max(1, remaining)));
        }
        chEmitNetworkStatus(null);
    }

    async function chWithBackendSerial(task) {
        const previous = chBackendScheduler.tail;
        let release;
        chBackendScheduler.tail = new Promise(resolve => { release = resolve; });
        await previous;
        try { return await task(); }
        finally { try { release(); } catch (_) {} }
    }

    async function chWaitForBackendGate(label = '', lane = CH_BACKEND_LANE_DETAIL) {
        const now = Date.now();
        const laneDeadline = Number(chBackendScheduler.laneNextAllowedAt?.[lane] || 0);
        const cooldownDeadline = Number(chBackendScheduler.cooldownUntil || 0);
        const deadline = Math.max(laneDeadline, cooldownDeadline);
        if (deadline <= now) {
            if (cooldownDeadline <= now) {
                chBackendScheduler.cooldownUntil = 0;
                chBackendScheduler.cooldownReason = null;
            }
            chEmitNetworkStatus(null);
            return;
        }
        const waitMs = deadline - now;
        const is429 = chBackendScheduler.cooldownReason === 'HTTP_429' && cooldownDeadline >= deadline;
        const laneLabel = lane === CH_BACKEND_LANE_DISCOVERY ? '云端对话' : lane === CH_BACKEND_LANE_ATTACHMENT ? '附件信息' : '对话内容';
        await chSchedulerSleep(
            waitMs,
            is429 ? '请求过多，暂时休息' : '等待下一次请求',
            `${label ? `${label} · ` : ''}${is429 ? '稍后自动继续' : `${laneLabel}`}`,
            is429
        );
    }

    function chAfterBackendAttempt(policy, lane) {
        const p = chNormalizeNetworkPolicy(policy);
        chBackendScheduler.laneRequestCount[lane] = Number(chBackendScheduler.laneRequestCount[lane] || 0) + 1;
        let delay = chLaneDelayMs(lane, p);
        // Batch pauses belong only to expensive conversation-detail traffic. Discovery and
        // attachment metadata have their own lightweight lane cadence and never consume the
        // detail batch counter.
        if (lane === CH_BACKEND_LANE_DETAIL && chBackendScheduler.laneRequestCount[lane] % p.batchSize === 0) {
            delay = Math.max(delay, chNetworkBatchPauseMs(p) * (1 + 0.5 * Math.max(0, Number(chBackendScheduler.rateLimitLevel || 0))));
        }
        if (lane === CH_BACKEND_LANE_ATTACHMENT && chBackendScheduler.laneRequestCount[lane] % CH_ATTACHMENT_META_BATCH_SIZE === 0) {
            const attachmentPause = CH_ATTACHMENT_META_PAUSE_MIN_MS + Math.random() * CH_ATTACHMENT_META_PAUSE_JITTER_MS;
            delay = Math.max(delay, attachmentPause * (1 + 0.5 * Math.max(0, Number(chBackendScheduler.rateLimitLevel || 0))));
        }
        chBackendScheduler.laneNextAllowedAt[lane] = Math.max(
            Number(chBackendScheduler.laneNextAllowedAt[lane] || 0),
            Date.now() + delay
        );
    }

    async function chBackendFetch(resource, options = {}) {
        if (!chIsBackendControlUrl(resource)) return chRawChatHarborFetch(resource, options);
        const lane = chBackendLaneFor(resource);
        return chWithBackendSerial(async () => {
            const policy = chBackendPolicy();
            const maxAttempts = 1 + policy.maxRetries;
            let lastError = null;
            let lastResponse = null;
            for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                if (chSyncRun?.active) await chControlCheckpoint('backend-request');
                await chWaitForBackendGate('', lane);
                try {
                    const response = await chRawChatHarborFetch(resource, options);
                    lastResponse = response;
                    chAfterBackendAttempt(policy, lane);
                    const status = Number(response?.status || 0);
                    const requestLabel = chBackendRequestDescriptor(resource, lane);
                    if (status === 429) {
                        const retryMs = chRetryDelayForFailure({ status, lane, attempt });
                        chBackendScheduler.cooldownUntil = Math.max(chBackendScheduler.cooldownUntil || 0, Date.now() + retryMs);
                        chBackendScheduler.cooldownReason = 'HTTP_429';
                        chRegisterRateLimit();
                        if (attempt < maxAttempts) {
                            await chWaitForBackendGate(`${requestLabel} · 第 ${attempt}/${policy.maxRetries} 次重试前`, lane);
                            continue;
                        }
                    } else if (status >= 500 && status <= 599 && attempt < maxAttempts) {
                        const retryMs = chRetryDelayForFailure({ status, lane, attempt });
                        await chSchedulerSleep(retryMs, chRetryPrimary(status), `${requestLabel} · 第 ${attempt}/${policy.maxRetries} 次重试前`, true);
                        continue;
                    }
                    // 401/403/404 and other non-retryable HTTP responses return immediately to
                    // the owning operation, which records the concrete conversation/asset failure.
                    return response;
                } catch (err) {
                    if (chIsCancellation(err)) throw err;
                    lastError = err;
                    chAfterBackendAttempt(policy, lane);
                    if (attempt >= maxAttempts) break;
                    const requestLabel = chBackendRequestDescriptor(resource, lane);
                    const retryMs = chRetryDelayForFailure({ status: null, lane, attempt });
                    await chSchedulerSleep(retryMs, chRetryPrimary(null), `${requestLabel} · 第 ${attempt}/${policy.maxRetries} 次重试前`, true);
                }
            }
            if (lastResponse) return lastResponse;
            throw lastError || new Error('ChatHarbor backend request failed');
        });
    }

    async function chDataTransferFetch(resource, options = {}) {
        const policy = chBackendPolicy();
        const maxAttempts = 1 + policy.maxRetries;
        let lastError = null;
        let lastResponse = null;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            if (chSyncRun?.active) await chControlCheckpoint('binary-transfer');
            if ((chBackendScheduler.cooldownUntil || 0) > Date.now()) await chWaitForBackendGate('附件数据下载', CH_BACKEND_LANE_ATTACHMENT);
            try {
                const response = await chRawChatHarborFetch(resource, options);
                lastResponse = response;
                const status = Number(response?.status || 0);
                if (status === 429) {
                    const retryMs = chRetryDelayForFailure({ status, lane: CH_BACKEND_LANE_ATTACHMENT, attempt, binary: true });
                    chBackendScheduler.cooldownUntil = Math.max(chBackendScheduler.cooldownUntil || 0, Date.now() + retryMs);
                    chBackendScheduler.cooldownReason = 'HTTP_429';
                        chRegisterRateLimit();
                    if (attempt < maxAttempts) { await chWaitForBackendGate(`附件数据 · 第 ${attempt}/${policy.maxRetries} 次重试前`, CH_BACKEND_LANE_ATTACHMENT); continue; }
                } else if (status >= 500 && status <= 599 && attempt < maxAttempts) {
                    const retryMs = chRetryDelayForFailure({ status, lane: CH_BACKEND_LANE_ATTACHMENT, attempt, binary: true });
                    await chSchedulerSleep(retryMs, chRetryPrimary(status, true), `附件数据 · 第 ${attempt}/${policy.maxRetries} 次重试前`, true);
                    continue;
                }
                return response;
            } catch (err) {
                if (chIsCancellation(err)) throw err;
                lastError = err;
                if (attempt >= maxAttempts) break;
                const retryMs = chRetryDelayForFailure({ status: null, lane: CH_BACKEND_LANE_ATTACHMENT, attempt, binary: true });
                await chSchedulerSleep(retryMs, chRetryPrimary(null, true), `附件数据 · 第 ${attempt}/${policy.maxRetries} 次重试前`, true);
            }
        }
        if (lastResponse) return lastResponse;
        throw lastError || new Error('ChatHarbor binary transfer failed');
    }

    const chSyncRun = {
        active: false,
        paused: false,
        cancelRequested: false,
        cancelReason: null,
        phase: 'idle',
        policy: chLoadNetworkPolicy(),
        waiters: [],
        sleepDeadline: null,
        sleepPrimary: null
    };

    function chBeginControlledRun(policy = null) {
        if (chSyncRun.active) throw new Error('已有同步任务正在运行。');
        chSyncRun.active = true;
        chSyncRun.paused = false;
        chSyncRun.cancelRequested = false;
        chSyncRun.cancelReason = null;
        chSyncRun.phase = 'starting';
        chSyncRun.policy = chSaveNetworkPolicy(policy || chLoadNetworkPolicy());
        chSyncRun.waiters = [];
        chSyncRun.sleepDeadline = null;
        chSyncRun.sleepPrimary = null;
        chUpdateRunControlUi();
        return chSyncRun;
    }

    function chEndControlledRun() {
        const waiters = chSyncRun.waiters.splice(0);
        waiters.forEach(resolve => { try { resolve(); } catch (_) {} });
        chSyncRun.active = false;
        chSyncRun.paused = false;
        chSyncRun.cancelRequested = false;
        chSyncRun.cancelReason = null;
        chSyncRun.phase = 'idle';
        chSyncRun.sleepDeadline = null;
        chSyncRun.sleepPrimary = null;
        chUpdateRunControlUi();
    }

    function chRequestPause() {
        if (!chSyncRun.active || chSyncRun.cancelRequested) return false;
        chSyncRun.paused = true;
        chUpdateRunControlUi();
        return true;
    }

    function chResumeRun() {
        if (!chSyncRun.active) return false;
        chSyncRun.paused = false;
        const waiters = chSyncRun.waiters.splice(0);
        waiters.forEach(resolve => { try { resolve(); } catch (_) {} });
        chUpdateRunControlUi();
        return true;
    }

    function chRequestCancel(reason = 'USER_CANCELLED') {
        if (!chSyncRun.active) return false;
        chSyncRun.cancelRequested = true;
        chSyncRun.cancelReason = reason;
        chSyncRun.paused = false;
        const waiters = chSyncRun.waiters.splice(0);
        waiters.forEach(resolve => { try { resolve(); } catch (_) {} });
        chUpdateRunControlUi();
        return true;
    }

    function chCancellationError(message = '同步已取消。') {
        const err = new Error(message);
        err.name = 'ChatHarborCancelled';
        err.code = 'CHATHARBOR_CANCELLED';
        return err;
    }

    function chIsCancellation(err) {
        return err?.code === 'CHATHARBOR_CANCELLED' || err?.name === 'ChatHarborCancelled';
    }

    async function chControlCheckpoint(phase = null) {
        if (phase) chSyncRun.phase = phase;
        if (chSyncRun.cancelRequested) throw chCancellationError();
        while (chSyncRun.paused && !chSyncRun.cancelRequested) {
            chSetProgress('已暂停', '点击“继续”恢复；暂停期间不会发起新的详情请求或开始新的会话写入。', null);
            await new Promise(resolve => chSyncRun.waiters.push(resolve));
        }
        if (chSyncRun.cancelRequested) throw chCancellationError();
    }

    function chFormatRemainingDuration(ms) {
        const totalSeconds = Math.max(0, Math.ceil((Number(ms) || 0) / 1000));
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;
        return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    }

    async function chControlledSleep(ms, primary = '保守网络等待', secondary = '', options = {}) {
        const duration = Math.max(0, Math.round(Number(ms) || 0));
        const deadline = Date.now() + duration;
        const countdown = Boolean(options?.countdown);
        chSyncRun.sleepDeadline = deadline;
        chSyncRun.sleepPrimary = primary;
        let systemSuspended = false;
        try {
            while (true) {
                await chControlCheckpoint();
                const remaining = deadline - Date.now();
                if (remaining <= 0) break;
                if (remaining >= 1000) {
                    const waitText = countdown
                        ? `${secondary ? `${secondary} · ` : ''}剩余 ${chFormatRemainingDuration(remaining)}`
                        : (secondary || `剩余约 ${Math.ceil(remaining / 1000)} 秒`);
                    chSetProgress(primary, waitText, null);
                }
                const chunk = Math.min(1000, remaining);
                const before = Date.now();
                await sleep(chunk);
                const elapsed = Date.now() - before;
                // Browsers suspend timers during OS sleep / long background throttling.
                // Detect elapsed wall time instead of counting timer ticks.
                if (elapsed > chunk + 15000) systemSuspended = true;
            }
        } finally {
            chSyncRun.sleepDeadline = null;
            chSyncRun.sleepPrimary = null;
        }
        await chControlCheckpoint();
        if (systemSuspended && !chSyncRun.paused && !chSyncRun.cancelRequested) {
            const guardMs = chNetworkDelayMs(chSyncRun.policy);
            const guardDeadline = Date.now() + guardMs;
            while (Date.now() < guardDeadline) {
                await chControlCheckpoint('wake-guard');
                const remaining = guardDeadline - Date.now();
                chSetProgress('恢复保护等待', `检测到页面长时间挂起或系统休眠 · ${Math.max(1, Math.ceil(remaining / 1000))} 秒后继续`, null);
                await sleep(Math.min(1000, Math.max(1, remaining)));
            }
        }
        await chControlCheckpoint();
    }

    function chReconcileRuntimeState() {
        if (!chSyncRun.active) return;
        chUpdateRunControlUi();
        // Absolute deadlines are evaluated by chControlledSleep when timers resume.
        // User pause remains authoritative and is never auto-resumed here.
        if (chSyncRun.paused) return;
        if (chSyncRun.sleepDeadline && Date.now() >= chSyncRun.sleepDeadline) {
            const waiters = chSyncRun.waiters.splice(0);
            waiters.forEach(resolve => { try { resolve(); } catch (_) {} });
        }
    }

    document.addEventListener('visibilitychange', () => { if (!document.hidden) chReconcileRuntimeState(); });
    window.addEventListener('focus', chReconcileRuntimeState);
    window.addEventListener('pageshow', chReconcileRuntimeState);

    function chErrorStatus(err) {
        if (Number.isFinite(err?.status)) return Number(err.status);
        const match = String(err?.message || '').match(/\((\d{3})\)|HTTP\s+(\d{3})|\b(429|5\d\d|401|403)\b/i);
        return match ? Number(match[1] || match[2] || match[3]) : null;
    }

    function chRetryDelayMs(err, attempt) {
        const status = chErrorStatus(err);
        if (status === 429) return 300000 * Math.max(1, attempt);
        if (status && status >= 500) return 30000 * Math.max(1, attempt);
        if (status === 401 || status === 403) return null;
        return 30000 * Math.max(1, attempt);
    }

    async function chGetConversationConservative(id, workspaceId = null, title = null) {
        await chControlCheckpoint('detail-fetch');
        const previousTitle = chBackendContext.detailTitle;
        const previousId = chBackendContext.detailId;
        chBackendContext.detailTitle = title || null;
        chBackendContext.detailId = id || null;
        try {
            return await getConversation(id, workspaceId);
        } finally {
            chBackendContext.detailTitle = previousTitle;
            chBackendContext.detailId = previousId;
        }
    }

    function chUpdateRunControlUi() {
        const pauseBtn = document.getElementById('ch-pause-sync-btn');
        const cancelBtn = document.getElementById('ch-cancel-sync-btn');
        const backBtn = document.getElementById('back-btn');
        if (pauseBtn) {
            pauseBtn.style.display = chSyncRun.active ? '' : 'none';
            pauseBtn.disabled = !chSyncRun.active || chSyncRun.cancelRequested;
            pauseBtn.textContent = chSyncRun.paused ? '继续' : '暂停';
        }
        if (cancelBtn) {
            cancelBtn.style.display = chSyncRun.active ? '' : 'none';
            cancelBtn.disabled = !chSyncRun.active || chSyncRun.cancelRequested;
            cancelBtn.textContent = chSyncRun.cancelRequested ? '正在取消…' : '取消同步';
        }
        if (backBtn) {
            backBtn.disabled = chSyncRun.active;
            backBtn.title = chSyncRun.active ? '同步运行期间请先暂停/取消；“返回”不会被当作停止操作。' : '';
        }
    }

    function chExpectedByteLength(data) {
        if (typeof data === 'string') return new TextEncoder().encode(data).byteLength;
        if (data instanceof Blob) return data.size;
        if (data instanceof ArrayBuffer) return data.byteLength;
        if (ArrayBuffer.isView(data)) return data.byteLength;
        throw new Error('Unsupported directory-write payload');
    }

    async function chWriteRawFile(dirHandle, filename, data) {
        const fileHandle = await dirHandle.getFileHandle(filename, { create: true });
        const writable = await fileHandle.createWritable({ keepExistingData: false });
        try {
            await writable.write(data);
            await writable.close();
        } catch (err) {
            try { await writable.abort(); } catch (_) {}
            throw err;
        }
        return fileHandle;
    }

    async function chVerifiedDirectoryWrite(dirHandle, filename, data) {
        const tempName = `.${filename}.chatharbor.tmp`;
        const expectedBytes = chExpectedByteLength(data);

        const tempHandle = await chWriteRawFile(dirHandle, tempName, data);
        const tempFile = await tempHandle.getFile();
        if (tempFile.size !== expectedBytes) {
            try { await dirHandle.removeEntry(tempName); } catch (_) {}
            throw new Error(`Temporary write verification failed: ${filename}`);
        }

        const finalHandle = await chWriteRawFile(dirHandle, filename, data);
        const finalFile = await finalHandle.getFile();
        if (finalFile.size !== expectedBytes) {
            throw new Error(`Final write verification failed: ${filename}`);
        }

        try { await dirHandle.removeEntry(tempName); } catch (_) {}
        return finalHandle;
    }

    function chNewManifest() {
        const now = new Date().toISOString();
        return {
            schema_version: CH_MANIFEST_SCHEMA_VERSION,
            product: 'ChatHarbor',
            source: CH_PROVIDER_LABEL,
            provider: CH_PROVIDER,
            archive_layout_version: CH_ARCHIVE_LAYOUT_VERSION,
            created_at: now,
            updated_at: now,
            identity: 'conversation_id',
            signature_version: CH_SIGNATURE_VERSION,
            conversations: {}
        };
    }

    function chManifestLayoutVersion(manifest) {
        if (!manifest || typeof manifest !== 'object') return CH_ARCHIVE_LAYOUT_VERSION;
        const raw = Number(manifest.archive_layout_version);
        if (Number.isFinite(raw) && raw >= 1) return Math.trunc(raw);
        // Pre-Layout-v2 manifests did not carry an explicit layout version.
        return 1;
    }

    function chManifestProvider(manifest) {
        const provider = String(manifest?.provider || '').trim().toLowerCase();
        if (provider) return provider;
        // Older ChatHarbor manifests used source: ChatGPT without provider.
        const source = String(manifest?.source || '').trim().toLowerCase();
        return source === 'chatgpt' ? CH_PROVIDER : null;
    }

    function chManifestRequiresLayoutMigration(manifest) {
        if (!manifest || typeof manifest !== 'object') return false;
        if (manifest.migration_state?.type === 'archive_layout' &&
            Number(manifest.migration_state?.to) === CH_ARCHIVE_LAYOUT_VERSION) return true;
        return chManifestLayoutVersion(manifest) < CH_ARCHIVE_LAYOUT_VERSION;
    }

    function chValidateManifestCompatibility(manifest) {
        if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
            throw new Error('manifest root is not an object');
        }
        if (manifest.schema_version !== CH_MANIFEST_SCHEMA_VERSION) {
            throw new Error(`unsupported manifest schema: ${manifest.schema_version ?? 'missing'}`);
        }
        if (manifest.identity !== 'conversation_id') {
            throw new Error(`unsupported manifest identity: ${manifest.identity ?? 'missing'}`);
        }
        if (manifest.signature_version && manifest.signature_version !== CH_SIGNATURE_VERSION) {
            throw new Error(`unsupported signature version: ${manifest.signature_version}`);
        }
        if (!manifest.conversations || typeof manifest.conversations !== 'object' || Array.isArray(manifest.conversations)) {
            throw new Error('manifest.conversations is invalid');
        }
        const provider = chManifestProvider(manifest);
        if (provider && provider !== CH_PROVIDER) {
            throw new Error(`provider mismatch: expected ${CH_PROVIDER}, found ${provider}`);
        }
        const layout = chManifestLayoutVersion(manifest);
        if (layout > CH_ARCHIVE_LAYOUT_VERSION) {
            throw new Error(`unsupported archive layout: ${layout}`);
        }
        return manifest;
    }

    async function chReadManifest(rootHandle) {
        try {
            const handle = await rootHandle.getFileHandle(CH_MANIFEST_NAME);
            const file = await handle.getFile();
            const text = await file.text();
            const manifest = JSON.parse(text);

            chValidateManifestCompatibility(manifest);
            return manifest;
        } catch (err) {
            if (err?.name === 'NotFoundError') return chNewManifest();
            if (err instanceof SyntaxError) {
                throw new Error(`无法解析 ${CH_MANIFEST_NAME}，已停止以避免覆盖损坏的 manifest。`);
            }
            if (String(err?.message || '').includes('manifest')) throw err;
            throw err;
        }
    }

    async function chWriteManifest(rootHandle, manifest) {
        manifest.updated_at = new Date().toISOString();
        const text = JSON.stringify(manifest, null, 2);
        await chVerifiedDirectoryWrite(rootHandle, CH_MANIFEST_NAME, text);
        return text;
    }

    function chHex(buffer) {
        return Array.from(new Uint8Array(buffer))
            .map(byte => byte.toString(16).padStart(2, '0'))
            .join('');
    }

    async function chContentSignature(convData) {
        const signaturePayload = JSON.stringify({
            current_node: convData?.current_node ?? null,
            mapping: convData?.mapping ?? {}
        });
        const digest = await crypto.subtle.digest(
            'SHA-256',
            new TextEncoder().encode(signaturePayload)
        );
        return chHex(digest);
    }

    function chGetConversationId(entry, convData) {
        const id = convData?.conversation_id || convData?.id || entry?.id || null;
        if (!id) throw new Error('conversation_id missing; refusing archive commit');
        return id;
    }

    function chProgressElements() {
        return {
            root: document.getElementById('ch-sync-progress'),
            primary: document.getElementById('ch-sync-progress-primary'),
            secondary: document.getElementById('ch-sync-progress-secondary'),
            pct: document.getElementById('ch-sync-progress-pct'),
            bar: document.getElementById('ch-sync-progress-bar')
        };
    }

    const chRuntimeProgress = { active:false, processed:0, total:0, currentTitle:'' };

    function chSetRuntimeProgress({ active = chRuntimeProgress.active, processed = chRuntimeProgress.processed, total = chRuntimeProgress.total, currentTitle = chRuntimeProgress.currentTitle } = {}) {
        chRuntimeProgress.active = Boolean(active);
        chRuntimeProgress.processed = Math.max(0, Number(processed) || 0);
        chRuntimeProgress.total = Math.max(0, Number(total) || 0);
        chRuntimeProgress.currentTitle = String(currentTitle || '');
    }

    function chSetProgress(primary, secondary = '', percent = null) {
        const els = chProgressElements();
        if (!els.root) return;
        els.root.style.display = 'block';

        let shownPrimary = primary || '';
        let shownSecondary = secondary || '';
        let normalized = Number.isFinite(percent) ? Math.max(0, Math.min(100, Math.round(percent))) : null;
        if (chRuntimeProgress.active && chRuntimeProgress.total > 0) {
            const done = Math.min(chRuntimeProgress.processed, chRuntimeProgress.total);
            normalized = Math.round((done / chRuntimeProgress.total) * 100);
            shownPrimary = `会话进度 ${done} / ${chRuntimeProgress.total}`;
            const current = chRuntimeProgress.currentTitle ? `当前：${chRuntimeProgress.currentTitle}` : '';
            const action = [primary, secondary].filter(Boolean).join(' · ');
            shownSecondary = [current, action].filter(Boolean).join('\n');
        }
        if (els.primary) els.primary.textContent = shownPrimary;
        if (els.secondary) { els.secondary.textContent = shownSecondary; els.secondary.style.whiteSpace = 'pre-line'; }
        if (els.pct) els.pct.textContent = normalized == null ? '' : `${normalized}%`;
        if (els.bar) {
            els.bar.style.width = normalized == null ? '0%' : `${normalized}%`;
            els.bar.style.opacity = normalized == null ? '0.35' : '1';
        }
    }

    function chProgressPercent(conversationIndex, conversationTotal, fractionWithinConversation) {
        if (!conversationTotal) return 0;
        const fraction = Math.max(0, Math.min(1, Number(fractionWithinConversation) || 0));
        return ((conversationIndex + fraction) / conversationTotal) * 100;
    }

    function chReportProgress(btn, {
        conversationIndex,
        conversationTotal,
        title,
        phase,
        detail = '',
        fraction = 0
    }) {
        const shortTitle = String(title || 'Untitled Conversation').slice(0, 42);
        chSetRuntimeProgress({ currentTitle: shortTitle });
        const shownPhase = phase === '下载附件' ? '正在下载附件'
            : phase === '保留已有附件' ? '正在检查附件'
            : ['写入 JSON','写入 Markdown','计算内容签名','提交 manifest','完成'].includes(phase) ? '正在保存'
            : (phase || '正在处理');
        chSetProgress(shownPhase, detail || '', null);
        // Runtime progress is intentionally shown only in the workspace progress card.
        // Keep the launcher free of duplicate percentage/status pills.
    }

    function chPlanAttachmentBackfill(convData, existingRecord = null) {
        const references = collectVisibleAttachments(convData || {});
        const assets = Array.isArray(existingRecord?.assets) ? existingRecord.assets : [];
        const existingByKey = new Map();
        for (const asset of assets) {
            const key = chAssetReferenceKey(asset);
            if (key && asset?.path && !existingByKey.has(key)) existingByKey.set(key, asset);
        }

        const retained = [];
        const missing = [];
        for (const reference of references) {
            const key = chAttachmentReferenceKey(reference);
            const asset = key ? existingByKey.get(key) : null;
            if (asset) retained.push({ reference, asset, key });
            else missing.push(reference);
        }
        return { references, retained, missing };
    }

    function chAttachmentFailureKey(failure) {
        if (!failure) return '';
        return failure.kind === 'sandbox'
            ? `sandbox:${failure.message_id || ''}:${failure.sandbox_path || ''}`
            : `file:${failure.file_id || ''}`;
    }

    function chCurrentAttachmentFailures(references, record) {
        const activeKeys = new Set(references.map(chAttachmentReferenceKey).filter(Boolean));
        return (Array.isArray(record?.attachment_failures) ? record.attachment_failures : [])
            .filter(failure => activeKeys.has(chAttachmentFailureKey(failure)));
    }

    function chAttachmentNeedsAction(record, retryFailedAttachments = false) {
        const state = chRecordAttachmentState(record);
        if (state === 'complete' || state === 'none') return false;
        if (state === 'unknown' || state === 'not_downloaded') return true;
        const failures = Array.isArray(record?.attachment_failures) ? record.attachment_failures : [];
        const detected = Number(record?.attachment_detected || 0);
        const downloaded = Number(record?.attachment_downloaded || 0);
        // A fully accounted partial record has no unattempted attachment left.  Its failure
        // ledger is retried only when this run explicitly requests it.
        return Boolean(retryFailedAttachments) || detected > downloaded + failures.length;
    }

    function chExistingAssetAsDownloadedFile(asset, targetPrefix, reference = null) {
        const relativeLink = chRelativeMarkdownPath(targetPrefix, asset?.path || '');
        return {
            name: asset?.name || 'attachment',
            path: relativeLink,
            disk_path: asset?.path || '',
            root_path: asset?.path || '',
            kind: asset?.kind || 'file',
            isImage: Boolean(asset?.is_image),
            messageId: asset?.message_id || null,
            ownerRole: asset?.owner_role || reference?.ownerRole || null,
            sourceCategory: asset?.source_category || reference?.sourceCategory || chAttachmentSourceCategory(asset?.owner_role || reference?.ownerRole, asset?.kind || reference?.kind, Boolean(asset?.is_image || reference?.isImage)),
            referenceKind: asset?.reference_kind || asset?.kind || reference?.kind || null,
            size_bytes: Number(asset?.size_bytes || 0),
            source_file_id: asset?.source_file_id || null,
            source_sandbox_path: asset?.source_sandbox_path || null,
            reusedExisting: true
        };
    }

    async function chWriteAttachmentsToDirectory(
        targetDir,
        convData,
        workspaceId,
        progress = null,
        options = {}
    ) {
        const targetPrefix = String(options.targetPrefix || '');
        const existingRecord = options.existingRecord || null;
        const fetchBinary = options.fetchAttachmentBinary || fetchAttachmentBinary;
        const writeBinary = options.writeAttachment || chVerifiedDirectoryWrite;
        const backfillPlan = chPlanAttachmentBackfill(convData, existingRecord);
        const references = backfillPlan.references;
        const failures = [];
        const runFailures = [];
        const files = [];
        const sandboxPaths = new Map();
        const usedNames = new Set();
        const newlyWrittenRootPaths = [];
        const rootHandle = options.rootHandle || null;

        if (references.length === 0) {
            return {
                detected: 0,
                files,
                failures,
                sandboxPaths,
                folderName: null,
                assetDirPath: null,
                reusedCount: 0,
                downloadedNow: 0,
                missingBefore: 0,
                newlyWrittenRootPaths: []
            };
        }

        const folderName = generateUniqueFilename(convData).replace(/\.json$/i, '') + '_files';
        let missingRefs = [...backfillPlan.missing];
        const verifiedRetained = [];
        for (const item of backfillPlan.retained) {
            let reusable = true;
            if (rootHandle && item.asset?.path) {
                const meta = await chRelativeFileMeta(rootHandle, item.asset.path);
                const expectedSize = Number(item.asset?.size_bytes || 0);
                reusable = Boolean(meta.exists) && !(expectedSize > 0 && meta.size != null && meta.size !== expectedSize);
            }
            if (reusable) verifiedRetained.push(item);
            else missingRefs.push(item.reference);
        }
        const currentFailures = chCurrentAttachmentFailures(references, existingRecord);
        const failedKeys = new Set(currentFailures.map(chAttachmentFailureKey).filter(Boolean));
        const retryFailedAttachments = Boolean(options.retryFailedAttachments);
        const attemptedKeys = new Set();
        missingRefs = missingRefs.filter(reference => {
            const key = chAttachmentReferenceKey(reference);
            const attempt = retryFailedAttachments || !failedKeys.has(key);
            if (attempt) attemptedKeys.add(key);
            return attempt;
        });
        const assetDir = missingRefs.length > 0
            ? await targetDir.getDirectoryHandle(folderName, { create: true })
            : null;

        // Reuse only assets whose Manifest identity and physical file both remain valid.
        for (const item of verifiedRetained) {
            const file = chExistingAssetAsDownloadedFile(item.asset, targetPrefix, item.reference);
            files.push(file);
            if (file.name) usedNames.add(file.name);
            if (item.reference?.kind === 'sandbox' && item.reference?.messageId && item.reference?.sandboxPath) {
                sandboxPaths.set(`${item.reference.messageId}|${item.reference.sandboxPath}`, file.path);
            }
        }

        const retainedCount = files.length;
        if (progress && retainedCount > 0) {
            progress({
                assetIndex: retainedCount,
                assetTotal: references.length,
                name: `复用已有 ${retainedCount} 个附件`,
                reusedCount: retainedCount,
                downloadedNow: 0
            });
        }

        for (let i = 0; i < missingRefs.length; i++) {
            const reference = missingRefs[i];
            try {
                const previousAttachmentName = chBackendContext.attachmentName;
                chBackendContext.attachmentName = reference.name || reference.fileId || reference.sandboxPath || 'attachment';
                let downloaded;
                try {
                    downloaded = await fetchBinary(reference, convData, workspaceId);
                } finally {
                    chBackendContext.attachmentName = previousAttachmentName;
                }
                const filename = uniqueAttachmentName(downloaded.filename, usedNames);
                await writeBinary(assetDir, filename, downloaded.data);

                const diskPath = `${folderName}/${filename}`;
                const rootPath = `${targetPrefix}${diskPath}`;
                newlyWrittenRootPaths.push(rootPath);
                const relativePath = encodeRelativePath(diskPath);

                files.push({
                    name: filename,
                    path: relativePath,
                    disk_path: diskPath,
                    root_path: rootPath,
                    kind: reference.kind,
                    isImage: reference.isImage,
                    messageId: reference.messageId,
                    ownerRole: reference.ownerRole,
                    sourceCategory: reference.sourceCategory || chAttachmentSourceCategory(reference.ownerRole, reference.kind, reference.isImage),
                    referenceKind: reference.kind || null,
                    size_bytes: chExpectedByteLength(downloaded.data),
                    source_file_id: reference.fileId || null,
                    source_sandbox_path: reference.sandboxPath || null,
                    reusedExisting: false
                });

                if (reference.kind === 'sandbox') {
                    sandboxPaths.set(`${reference.messageId}|${reference.sandboxPath}`, relativePath);
                }
            } catch (error) {
                const failure = {
                    kind: reference.kind,
                    file_id: reference.fileId || null,
                    sandbox_path: reference.sandboxPath || null,
                    message_id: reference.messageId || null,
                    name: reference.name,
                    owner_role: reference.ownerRole || null,
                    source_category: reference.sourceCategory || chAttachmentSourceCategory(reference.ownerRole, reference.kind, reference.isImage),
                    reference_kind: reference.kind || null,
                    error: error?.message || String(error)
                };
                failures.push(failure);
                runFailures.push({
                    ...failure,
                    attempted_at: new Date().toISOString(),
                    was_known_failure: failedKeys.has(chAttachmentReferenceKey(reference))
                });
            }

            // Progress is completion-based and monotonic.  Do not emit a second "before"
            // value for the same attachment; the counter advances exactly once per attempt.
            if (progress) {
                progress({
                    assetIndex: retainedCount + i + 1,
                    assetTotal: references.length,
                    name: reference.name || reference.fileId || reference.sandboxPath || 'attachment',
                    reusedCount: retainedCount,
                    downloadedNow: i + 1
                });
            }

        }

        const primaryAssetDir = missingRefs.length > 0
            ? `${targetPrefix}${folderName}`
            : (existingRecord?.asset_dir || (files[0]?.root_path ? chPathDirname(files[0].root_path) : null));

        const referenceByKey = new Map(references.map(reference => [chAttachmentReferenceKey(reference), reference]));
        const retainedFailures = currentFailures
            .filter(failure => !attemptedKeys.has(chAttachmentFailureKey(failure)))
            .map(failure => chEnrichAttachmentFailure(failure, referenceByKey.get(chAttachmentFailureKey(failure)) || null));
        return {
            detected: references.length,
            files,
            failures: retainedFailures.concat(failures),
            sandboxPaths,
            folderName,
            assetDirPath: primaryAssetDir,
            reusedCount: retainedCount,
            downloadedNow: files.length - retainedCount,
            attemptedNow: missingRefs.length,
            runFailures,
            missingBefore: missingRefs.length,
            newlyWrittenRootPaths
        };
    }

    function chExistingAttachmentResult(existingRecord) {
        const assets = Array.isArray(existingRecord?.assets) ? existingRecord.assets : [];
        if (assets.length === 0) return null;

        const sandboxPaths = new Map();
        let sandboxSourceComplete = true;

        const files = assets.map(asset => {
            if (asset?.kind === 'sandbox') {
                if (asset.message_id && asset.source_sandbox_path) {
                    sandboxPaths.set(
                        `${asset.message_id}|${asset.source_sandbox_path}`,
                        asset.markdown_path
                    );
                } else {
                    sandboxSourceComplete = false;
                }
            }

            return {
                name: asset.name,
                path: asset.markdown_path,
                disk_path: asset.path,
                kind: asset.kind,
                isImage: Boolean(asset.is_image),
                messageId: asset.message_id || null,
                ownerRole: asset.owner_role || null,
                sourceCategory: asset.source_category || chAttachmentStoredSourceCategory(asset),
                referenceKind: asset.reference_kind || asset.kind || null,
                size_bytes: asset.size_bytes || 0,
                source_file_id: asset.source_file_id || null,
                source_sandbox_path: asset.source_sandbox_path || null
            };
        });

        return {
            detected: existingRecord.attachment_detected ?? assets.length,
            files,
            failures: Array.isArray(existingRecord.attachment_failures)
                ? existingRecord.attachment_failures
                : [],
            sandboxPaths,
            folderName: existingRecord.asset_dir
                ? String(existingRecord.asset_dir).split('/').pop()
                : null,
            reusedExisting: true,
            sandboxSourceComplete
        };
    }

    async function chReadExistingText(rootHandle, relativePath) {
        const segments = String(relativePath || '')
            .split('/')
            .filter(Boolean);

        if (segments.length === 0) throw new Error('existing path missing');

        let dir = rootHandle;
        for (let i = 0; i < segments.length - 1; i++) {
            dir = await dir.getDirectoryHandle(segments[i]);
        }

        const handle = await dir.getFileHandle(segments[segments.length - 1]);
        const file = await handle.getFile();
        return await file.text();
    }

    async function chWriteConversationToDirectory({
        rootHandle,
        entry,
        convData,
        workspaceId,
        includeAttachments,
        retryFailedAttachments = false,
        existingRecord = null,
        existingAttachmentResultOverride = null,
        btn,
        conversationIndex,
        conversationTotal
    }) {
        const conversationId = chGetConversationId(entry, convData);
        const title = convData?.title || entry?.title || 'Untitled Conversation';

        const relativePrefix = chTargetRelativePrefix(entry);
        const targetDir = await chEnsureRelativeDirectory(rootHandle, relativePrefix);

        let attachmentResult = null;
        const preserveExistingAssets =
            !includeAttachments &&
            existingRecord &&
            (
                existingRecord.asset_dir ||
                (Array.isArray(existingRecord.assets) && existingRecord.assets.length > 0)
            );

        if (includeAttachments) {
            attachmentResult = await chWriteAttachmentsToDirectory(
                targetDir,
                convData,
                workspaceId,
                ({ assetIndex, assetTotal, name }) => {
                    const ratio = assetTotal ? assetIndex / assetTotal : 1;
                    chReportProgress(btn, {
                        conversationIndex,
                        conversationTotal,
                        title,
                        phase: '下载附件',
                        detail: `${assetIndex}/${assetTotal} · ${name}`,
                        fraction: 0.15 + ratio * 0.55
                    });
                },
                { targetPrefix: relativePrefix, existingRecord, rootHandle, retryFailedAttachments }
            );
        } else if (preserveExistingAssets) {
            attachmentResult = existingAttachmentResultOverride || chExistingAttachmentResult(existingRecord);
            chReportProgress(btn, {
                conversationIndex,
                conversationTotal,
                title,
                phase: '保留已有附件',
                detail: `${existingRecord.assets?.length || 0} 个已跟踪附件`,
                fraction: 0.70
            });
        }

        const jsonFilename = generateUniqueFilename(convData);
        const markdownFilename = generateMarkdownFilename(convData);
        const jsonText = JSON.stringify(convData, null, 2);

        let markdownText;
        if (
            preserveExistingAssets &&
            attachmentResult &&
            attachmentResult.sandboxSourceComplete === false &&
            existingRecord?.markdown_path
        ) {
            // Gate-3 manifests did not yet store original sandbox paths.
            // To avoid degrading already-valid local links during this one-time transition,
            // preserve the existing Markdown rather than rewriting it with unresolved sandbox URLs.
            markdownText = await chReadExistingText(rootHandle, existingRecord.markdown_path);
        } else {
            markdownText = convertConversationToMarkdown(convData, attachmentResult);
        }

        chReportProgress(btn, {
            conversationIndex,
            conversationTotal,
            title,
            phase: '写入 JSON',
            fraction: 0.76
        });
        await chVerifiedDirectoryWrite(targetDir, jsonFilename, jsonText);

        chReportProgress(btn, {
            conversationIndex,
            conversationTotal,
            title,
            phase: '写入 Markdown',
            fraction: 0.84
        });
        await chVerifiedDirectoryWrite(targetDir, markdownFilename, markdownText);

        chReportProgress(btn, {
            conversationIndex,
            conversationTotal,
            title,
            phase: '计算内容签名',
            fraction: 0.90
        });
        const contentSignature = await chContentSignature(convData);
        const syncedAt = new Date().toISOString();

        const assetDir = preserveExistingAssets
            ? (existingRecord.asset_dir || null)
            : (attachmentResult?.assetDirPath || (attachmentResult?.folderName ? `${relativePrefix}${attachmentResult.folderName}` : null));

        const assets = preserveExistingAssets
            ? (Array.isArray(existingRecord.assets) ? existingRecord.assets : [])
            : (attachmentResult?.files || []).map(file => ({
                path: file.root_path || `${relativePrefix}${file.disk_path}`,
                markdown_path: file.path,
                name: file.name,
                kind: file.kind,
                is_image: Boolean(file.isImage),
                message_id: file.messageId || null,
                owner_role: file.ownerRole || null,
                source_category: file.sourceCategory || chAttachmentSourceCategory(file.ownerRole, file.referenceKind || file.kind, file.isImage),
                reference_kind: file.referenceKind || file.kind || null,
                size_bytes: file.size_bytes,
                source_file_id: file.source_file_id || null,
                source_sandbox_path: file.source_sandbox_path || null
            }));

        const observed = chRemoteObservation(entry, existingRecord);
        const inspectedAttachments = chInspectAttachmentCompleteness(convData, {
            ...(existingRecord || {}),
            assets,
            attachment_failed: preserveExistingAssets ? (existingRecord?.attachment_failed ?? 0) : (attachmentResult?.failures?.length || 0)
        });
        const attachmentDetected = includeAttachments
            ? (attachmentResult?.detected ?? inspectedAttachments.detected)
            : inspectedAttachments.detected;
        const attachmentDownloaded = includeAttachments ? assets.length : (preserveExistingAssets ? (existingRecord?.attachment_downloaded ?? assets.length) : 0);
        const attachmentFailures = includeAttachments
            ? (attachmentResult?.failures || [])
            : (preserveExistingAssets ? (existingRecord?.attachment_failures || []) : []);
        const attachmentFailed = attachmentFailures.length;
        const attachmentState = includeAttachments
            ? (attachmentDetected === 0 ? 'none' : (attachmentFailed === 0 && attachmentDownloaded >= attachmentDetected ? 'complete' : 'partial'))
            : inspectedAttachments.state;

        return {
            conversation_id: conversationId,
            title,
            create_time: convData?.create_time ?? entry?.create_time ?? null,
            remote_update_time: convData?.update_time ?? entry?.update_time ?? null,
            is_archived: observed.remote_list_is_archived ?? convData?.is_archived ?? entry?.is_archived ?? false,
            project_id: observed.remote_list_project_id ?? null,
            project_title: observed.remote_list_project_title ?? null,
            ...observed,
            provider: CH_PROVIDER,
            archive_layout_version: CH_ARCHIVE_LAYOUT_VERSION,
            content_signature: contentSignature,
            signature_version: CH_SIGNATURE_VERSION,
            json_path: `${relativePrefix}${jsonFilename}`,
            markdown_path: `${relativePrefix}${markdownFilename}`,
            json_bytes: chExpectedByteLength(jsonText),
            markdown_bytes: chExpectedByteLength(markdownText),
            asset_dir: assetDir,
            assets,
            attachment_state: attachmentState,
            attachments_checked_at: new Date().toISOString(),
            attachment_detected: attachmentDetected,
            attachment_downloaded: attachmentDownloaded,
            attachment_failed: attachmentFailed,
            attachment_failures: attachmentFailures,
            attachments_preserved_without_download: Boolean(preserveExistingAssets),
            synced_at: syncedAt,
            __ch_attachment_report: includeAttachments ? {
                conversation_id: conversationId,
                title,
                detected: Number(attachmentResult?.detected || 0),
                attempted: Number(attachmentResult?.attemptedNow || 0),
                downloaded: Number(attachmentResult?.downloadedNow || 0),
                failures: Array.isArray(attachmentResult?.runFailures) ? attachmentResult.runFailures : []
            } : null,
            __ch_new_asset_paths: attachmentResult?.newlyWrittenRootPaths || []
        };
    }

    async function chDirectoryWriteSelected({
        rootHandle,
        mode = 'personal',
        workspaceId = null,
        conversationEntries = [],
        includeAttachments = false
    }) {
        if (!rootHandle) throw new Error('Directory handle is required');
        if (!Array.isArray(conversationEntries) || conversationEntries.length === 0) {
            throw new Error('No conversations selected');
        }

        const btn = getExportButton();
        btn.disabled = true;

        chSetProgress('准备同步', '检查登录状态…', 0);

        if (!await ensureAccessToken()) {
            btn.disabled = false;
            setFabStatus(btn, EXPORT_BUTTON_LABEL);
            return;
        }

        chSetProgress('准备同步', `读取 ${CH_MANIFEST_NAME}…`, 1);
        const manifest = await chReadManifest(rootHandle);

        const results = [];
        let failed = 0;

        try {
            for (let i = 0; i < conversationEntries.length; i++) {
                const entry = conversationEntries[i];
                const title = entry?.title || 'Untitled Conversation';

                chReportProgress(btn, {
                    conversationIndex: i,
                    conversationTotal: conversationEntries.length,
                    title,
                    phase: '获取对话',
                    detail: entry?.id || '',
                    fraction: 0.05
                });

                try {
                    const convData = await getConversation(entry.id, workspaceId);

                    const resolvedConversationId =
                        convData?.conversation_id || convData?.id || entry?.id || null;
                    const existingRecord = resolvedConversationId
                        ? (manifest.conversations[resolvedConversationId] || null)
                        : null;

                    const record = await chWriteConversationToDirectory({
                        rootHandle,
                        entry,
                        convData,
                        workspaceId,
                        includeAttachments,
                        existingRecord,
                        btn,
                        conversationIndex: i,
                        conversationTotal: conversationEntries.length
                    });

                    chReportProgress(btn, {
                        conversationIndex: i,
                        conversationTotal: conversationEntries.length,
                        title,
                        phase: '提交 manifest',
                        detail: record.conversation_id,
                        fraction: 0.96
                    });

                    // conversation_id is the manifest key and canonical identity.
                    manifest.conversations[record.conversation_id] = record;
                    await chWriteManifest(rootHandle, manifest);

                    results.push(record);

                    chReportProgress(btn, {
                        conversationIndex: i,
                        conversationTotal: conversationEntries.length,
                        title,
                        phase: '完成',
                        detail: record.conversation_id,
                        fraction: 1
                    });
                } catch (err) {
                    failed++;
                    console.error('[ChatHarbor Archive] Directory/manifest commit failed:', entry?.id, err);
                    chSetProgress(
                        `同步 ${i + 1} / ${conversationEntries.length} · 失败`,
                        `${title} · ${err?.message || err}`,
                        chProgressPercent(i, conversationEntries.length, 1)
                    );
                }

                if (i + 1 < conversationEntries.length) await sleep(jitter());
            }

            const downloadedAttachments = results.reduce(
                (n, item) => n + item.attachment_downloaded, 0
            );
            const failedAttachments = results.reduce(
                (n, item) => n + item.attachment_failed, 0
            );

            const manifestCount = Object.keys(manifest.conversations).length;

            chSetProgress(
                failed ? '归档写入完成（存在失败）' : '归档写入完成',
                `成功 ${results.length} / ${conversationEntries.length} · manifest 共 ${manifestCount} 条`,
                100
            );
            // Non-blocking completion: keep 100% visible immediately.
            setFabStatus(btn, failed ? '⚠️ 归档写入完成' : '✅ 归档写入完成');


            return {
                planned: conversationEntries.length,
                succeeded: results.length,
                failed,
                manifest_count: manifestCount,
                results
            };
        } finally {
            setTimeout(() => {
                btn.disabled = false;
                setFabStatus(btn, EXPORT_BUTTON_LABEL);
            }, 1500);
        }
    }

    // ======================== ChatHarbor Integrated Sync: Read-only Archive Scan + Preflight Planner ========================
    // This layer is intentionally read-only:
    // - no conversation detail fetch
    // - no archive writes
    // - no manifest commits
    // - no rename cleanup
    // - no deletion of LOCAL_ONLY / legacy assets

    function chJoinRelativePath(...parts) {
        return parts
            .flatMap(part => String(part || '').split('/'))
            .filter(Boolean)
            .join('/');
    }

    function chRemoteConversationId(entry) {
        const id = entry?.id || entry?.conversation_id || null;
        return id ? String(id) : '';
    }

    function chTimeRelation(a, b) {
        const aa = normalizeEpochSeconds(a);
        const bb = normalizeEpochSeconds(b);
        if (!aa || !bb) return 'unknown';
        return Math.abs(aa - bb) <= 0.001 ? 'same' : 'different';
    }

    function chTimeEquivalent(a, b) {
        return chTimeRelation(a, b) === 'same';
    }

    function chRecordListTitle(record) {
        return Object.prototype.hasOwnProperty.call(record || {}, 'remote_list_title')
            ? String(record?.remote_list_title ?? '')
            : String(record?.title ?? '');
    }

    function chRecordListUpdateTime(record) {
        return Object.prototype.hasOwnProperty.call(record || {}, 'remote_list_update_time')
            ? record?.remote_list_update_time
            : record?.remote_update_time;
    }

    function chRecordListArchiveState(record) {
        return Object.prototype.hasOwnProperty.call(record || {}, 'remote_list_is_archived')
            ? record?.remote_list_is_archived
            : (Object.prototype.hasOwnProperty.call(record || {}, 'is_archived') ? Boolean(record?.is_archived) : null);
    }

    function chRecordListProjectId(record) {
        return Object.prototype.hasOwnProperty.call(record || {}, 'remote_list_project_id')
            ? record?.remote_list_project_id
            : (Object.prototype.hasOwnProperty.call(record || {}, 'project_id') ? record?.project_id : null);
    }

    function chRecordListProjectTitle(record) {
        return Object.prototype.hasOwnProperty.call(record || {}, 'remote_list_project_title')
            ? record?.remote_list_project_title
            : (Object.prototype.hasOwnProperty.call(record || {}, 'project_title') ? record?.project_title : null);
    }

    function chRemoteObservation(entry, existingRecord = null) {
        const existing = existingRecord || {};
        const projectState = entry?.__chProjectState || ((entry?.projectId || entry?.projectTitle) ? 'known' : 'unknown');
        const archiveState = entry?.__chArchiveState || (Object.prototype.hasOwnProperty.call(entry || {}, 'is_archived') ? 'known' : 'unknown');
        return {
            remote_list_title: String(entry?.title ?? chRecordListTitle(existing)),
            remote_list_update_time: normalizeEpochSeconds(entry?.update_time || 0) || null,
            remote_list_is_archived: archiveState === 'unknown'
                ? chRecordListArchiveState(existing)
                : Boolean(entry?.is_archived),
            remote_list_project_id: projectState === 'unknown'
                ? chRecordListProjectId(existing)
                : (entry?.projectId ?? null),
            remote_list_project_title: projectState === 'unknown'
                ? chRecordListProjectTitle(existing)
                : (entry?.projectTitle ?? null),
            remote_observed_at: new Date().toISOString()
        };
    }

    function chInferLegacyAttachmentState(record) {
        if (!record || typeof record !== 'object') return 'unknown';
        const assets = Array.isArray(record.assets) ? record.assets : [];
        const detected = Number(record.attachment_detected);
        const downloaded = Number(record.attachment_downloaded);
        const failed = Number(record.attachment_failed);
        const countsKnown = [detected, downloaded, failed].every(Number.isFinite);

        // A positive legacy detected count proves that the detail was inspected.  When all
        // detected assets were downloaded, no failures remain, and the Manifest tracks at
        // least that many files, the old record is strong enough to upgrade to COMPLETE
        // without another network verification.
        if (countsKnown && detected > 0) {
            if (failed === 0 && downloaded >= detected && assets.length >= detected) return 'complete';
            if (downloaded > 0 || failed > 0 || assets.length > 0) return 'partial';
            return 'not_downloaded';
        }

        // Zero in old manifests is ambiguous: it can mean "none" or "not inspected".
        // Only a newer explicit checked-at marker makes zero safe to interpret as NONE.
        if (countsKnown && detected === 0 && record.attachments_checked_at) return 'none';
        if (assets.length > 0) return 'partial';
        return 'unknown';
    }

    function chRecordAttachmentState(record) {
        const value = String(record?.attachment_state || '').toLowerCase();
        if (['unknown','none','complete','partial','not_downloaded'].includes(value)) return value;
        return chInferLegacyAttachmentState(record);
    }


    const CH_ATTACHMENT_SOURCE_CATEGORIES = Object.freeze([
        'user_upload',
        'assistant_generated_deliverable',
        'generated_media',
        'assistant_asset',
        'unknown'
    ]);

    function chAttachmentSourceCategory(ownerRole, kind, isImage = false, explicit = null) {
        const value = String(explicit || '').trim();
        if (CH_ATTACHMENT_SOURCE_CATEGORIES.includes(value)) return value;
        const role = String(ownerRole || '').toLowerCase();
        const refKind = String(kind || '').toLowerCase();
        if (role === 'user') return 'user_upload';
        if (refKind === 'sandbox' && (role === 'assistant' || !role)) return 'assistant_generated_deliverable';
        if (role === 'tool' && isImage) return 'generated_media';
        if (role === 'assistant' || role === 'tool') return 'assistant_asset';
        return 'unknown';
    }

    function chAttachmentSourceLabel(category) {
        return ({
            user_upload: chT('用户上传','User upload'),
            assistant_generated_deliverable: chT('ChatGPT生成','ChatGPT generated'),
            generated_media: chT('生成媒体','Generated media'),
            assistant_asset: chT('Assistant资源','Assistant asset'),
            unknown: chT('未知','Unknown')
        })[String(category || '')] || chT('未知','Unknown');
    }

    function chAttachmentFailureDisplayList(record) {
        return Array.isArray(record?.__ch_display_attachment_failures)
            ? record.__ch_display_attachment_failures
            : (Array.isArray(record?.attachment_failures) ? record.attachment_failures : []);
    }

    function chAttachmentStoredSourceCategory(item) {
        return chAttachmentSourceCategory(
            item?.owner_role || item?.ownerRole || null,
            item?.reference_kind || item?.kind || null,
            Boolean(item?.is_image || item?.isImage),
            item?.source_category || item?.sourceCategory || null
        );
    }

    function chEnrichAttachmentFailure(failure, reference = null) {
        const kind = failure?.reference_kind || failure?.kind || reference?.kind || null;
        const ownerRole = failure?.owner_role || reference?.ownerRole || null;
        const sourceCategory = chAttachmentSourceCategory(
            ownerRole,
            kind,
            Boolean(reference?.isImage),
            failure?.source_category || reference?.sourceCategory || null
        );
        return {
            ...(failure || {}),
            kind: failure?.kind || kind || null,
            reference_kind: kind || null,
            owner_role: ownerRole || null,
            source_category: sourceCategory
        };
    }

    function chCountMapIncrement(map, key, amount = 1) {
        const normalized = String(key || 'unknown');
        map.set(normalized, (map.get(normalized) || 0) + amount);
    }

    function chMapToSortedObject(map) {
        return Object.fromEntries([...map.entries()].sort((a,b)=>String(a[0]).localeCompare(String(b[0]))));
    }

    function chEmptyAttachmentProvenanceSummary() {
        return {
            successfulTotal: 0,
            failedTotal: 0,
            successBySource: {},
            failedBySource: {},
            failedByKind: {},
            failedByStage: {},
            failedByError: {},
            sourceByError: {},
            unknownFailures: 0,
            reconstructedFromLocalJson: 0,
            localJsonReadErrors: 0
        };
    }

    function chSummarizeLocalAttachmentProvenance(localScan) {
        if (!localScan?.manifestById) {
            localScan.attachmentProvenance = chEmptyAttachmentProvenanceSummary();
            return localScan.attachmentProvenance;
        }
        const successBySource = new Map();
        const failedBySource = new Map();
        const failedByKind = new Map();
        const failedByStage = new Map();
        const failedByError = new Map();
        const sourceError = new Map();
        let successfulTotal = 0;
        let failedTotal = 0;
        let unknownFailures = 0;

        for (const record of localScan.manifestById.values()) {
            const assets = Array.isArray(record?.assets) ? record.assets : [];
            for (const asset of assets) {
                const category = chAttachmentStoredSourceCategory(asset);
                successfulTotal++;
                chCountMapIncrement(successBySource, category);
            }

            const rawFailures = Array.isArray(record?.attachment_failures) ? record.attachment_failures : [];
            const displayFailures = rawFailures.map(failure => chEnrichAttachmentFailure(failure));
            record.__ch_display_attachment_failures = displayFailures;
            for (const failure of displayFailures) {
                const source = failure.source_category || 'unknown';
                const kind = failure.reference_kind || failure.kind || 'unknown';
                const stage = chAttachmentFailureStage(failure.error);
                const error = String(failure.error || chT('未知错误','Unknown error'));
                failedTotal++;
                if (source === 'unknown') unknownFailures++;
                chCountMapIncrement(failedBySource, source);
                chCountMapIncrement(failedByKind, kind);
                chCountMapIncrement(failedByStage, stage);
                chCountMapIncrement(failedByError, error);
                const cross = sourceError.get(source) || new Map();
                chCountMapIncrement(cross, error);
                sourceError.set(source, cross);
            }
        }

        const sourceByError = {};
        for (const [source, errors] of [...sourceError.entries()].sort((a,b)=>a[0].localeCompare(b[0]))) {
            sourceByError[source] = chMapToSortedObject(errors);
        }
        const summary = {
            successfulTotal,
            failedTotal,
            successBySource: chMapToSortedObject(successBySource),
            failedBySource: chMapToSortedObject(failedBySource),
            failedByKind: chMapToSortedObject(failedByKind),
            failedByStage: chMapToSortedObject(failedByStage),
            failedByError: chMapToSortedObject(failedByError),
            sourceByError,
            unknownFailures,
            reconstructedFromLocalJson: 0,
            localJsonReadErrors: 0
        };
        localScan.attachmentProvenance = summary;
        return summary;
    }

    function chAttachmentReferenceKey(ref) {
        if (!ref) return '';
        if (ref.kind === 'sandbox') return `sandbox:${ref.messageId || ''}:${ref.sandboxPath || ''}`;
        return `file:${ref.fileId || ''}`;
    }

    function chAssetReferenceKey(asset) {
        if (!asset) return '';
        if (asset.kind === 'sandbox') return `sandbox:${asset.message_id || ''}:${asset.source_sandbox_path || ''}`;
        return `file:${asset.source_file_id || ''}`;
    }

    function chInspectAttachmentCompleteness(convData, record = null) {
        const refs = collectVisibleAttachments(convData || {});
        if (refs.length === 0) return { state: 'none', detected: 0, missing: 0 };
        const assets = Array.isArray(record?.assets) ? record.assets : [];
        const assetKeys = new Set(assets.map(chAssetReferenceKey).filter(Boolean));
        const refKeys = refs.map(chAttachmentReferenceKey).filter(Boolean);
        const missing = refKeys.filter(key => !assetKeys.has(key)).length;
        const failed = Number(record?.attachment_failed || 0);
        if (record && missing === 0 && failed === 0 && refKeys.length > 0) {
            return { state: 'complete', detected: refs.length, missing: 0 };
        }
        if (!record || assets.length === 0) return { state: 'not_downloaded', detected: refs.length, missing: refs.length };
        return { state: 'partial', detected: refs.length, missing };
    }

    async function chCollectPreflightRemoteUniverse(mode, workspaceId, currentList) {
        const base = Array.isArray(currentList) ? currentList.slice() : [];
        try {
            if (mode === 'team' || (mode === 'personal' && workspaceId)) {
                return { remoteList: base, complete: true, note: null };
            }
            if (mode === 'personal') {
                const projectList = await listProjectSpaceConversations(workspaceId);
                return {
                    remoteList: chMergeRemoteEntries(base.concat(projectList)),
                    complete: true,
                    note: `combined personal/root list (${base.length}) + project list (${projectList.length})`
                };
            }
            if (mode === 'project') {
                if (workspaceId) {
                    const fullList = await listConversations(workspaceId);
                    return {
                        remoteList: fullList,
                        complete: true,
                        note: `resolved full workspace list (${fullList.length})`
                    };
                }
                const rootList = await listConversations(null);
                return {
                    remoteList: chMergeRemoteEntries(rootList.concat(base)),
                    complete: true,
                    note: `combined personal/root list (${rootList.length}) + project list (${base.length})`
                };
            }
            return { remoteList: base, complete: false, note: `unknown picker mode: ${mode}` };
        } catch (err) {
            return {
                remoteList: base,
                complete: false,
                note: `complementary remote-list scan failed: ${err?.message || String(err)}`
            };
        }
    }

    function chLooksLikeConversationJson(data) {
        return Boolean(
            data &&
            typeof data === 'object' &&
            !Array.isArray(data) &&
            (data.conversation_id || data.id) &&
            data.mapping &&
            typeof data.mapping === 'object' &&
            !Array.isArray(data.mapping)
        );
    }

    async function chReadJsonHandle(fileHandle) {
        const file = await fileHandle.getFile();
        return JSON.parse(await file.text());
    }

    async function chReadManifestForScan(rootHandle) {
        try {
            const handle = await rootHandle.getFileHandle(CH_MANIFEST_NAME);
            const manifest = await chReadJsonHandle(handle);
            chValidateManifestCompatibility(manifest);
            return { exists: true, manifest, error: null };
        } catch (err) {
            if (err?.name === 'NotFoundError') {
                return { exists: false, manifest: null, error: null };
            }
            return {
                exists: true,
                manifest: null,
                error: err?.message || String(err)
            };
        }
    }

    async function chRelativeFileMeta(rootHandle, relativePath) {
        const parts = chSplitPath(relativePath);
        if (!parts.length) return { exists: false, size: null };
        try {
            let dir = rootHandle;
            for (let i = 0; i < parts.length - 1; i++) dir = await dir.getDirectoryHandle(parts[i]);
            const handle = await dir.getFileHandle(parts[parts.length - 1]);
            const file = await handle.getFile();
            return { exists: true, size: Number.isFinite(file?.size) ? file.size : null };
        } catch (err) {
            if (err?.name === 'NotFoundError') return { exists: false, size: null };
            throw err;
        }
    }

    async function chScanLocalArchiveReadOnly(rootHandle, onProgress = null, options = {}) {
        const checkAssets = Boolean(options?.checkAssets);
        if (!rootHandle) throw new Error('Directory handle is required');

        const manifestResult = await chReadManifestForScan(rootHandle);
        const rawById = new Map();
        const rawByPath = new Map();
        const manifestById = new Map();
        const errors = [];
        let jsonFilesSeen = 0;
        let conversationJsonFiles = 0;
        let ignoredJsonFiles = 0;
        let skippedAssetDirs = 0;
        let trackedFastChecked = 0;
        let assetFastChecked = 0;
        let assetIntegrityIssues = 0;

        if (manifestResult.error) errors.push({ type:'MANIFEST_ERROR', id:null, path:CH_MANIFEST_NAME, message:manifestResult.error });

        const trackedJsonPathToId = new Map();
        if (manifestResult.manifest) {
            for (const [key, record] of Object.entries(manifestResult.manifest.conversations || {})) {
                const id = String(key || '');
                if (!id) { errors.push({type:'MANIFEST_EMPTY_ID',id:null,path:CH_MANIFEST_NAME,message:'manifest contains an empty conversation_id key'}); continue; }
                if (record?.conversation_id && String(record.conversation_id) !== id) {
                    errors.push({type:'MANIFEST_ID_MISMATCH',id,path:CH_MANIFEST_NAME,message:`record conversation_id ${record.conversation_id} does not match manifest key`});
                }
                const normalized = { ...(record || {}), conversation_id:id, tracking:'manifest' };
                manifestById.set(id, normalized);
                if (normalized.json_path) trackedJsonPathToId.set(String(normalized.json_path), id);
            }
        }

        const seenTrackedPaths = new Set();
        const walk = async (dirHandle, relativeDir = '') => {
            for await (const [name, handle] of dirHandle.entries()) {
                const relativePath = chJoinRelativePath(relativeDir, name);
                if (handle.kind === 'directory') {
                    if (/_files$/i.test(name)) { skippedAssetDirs++; continue; }
                    await walk(handle, relativePath);
                    continue;
                }
                if (!/\.json$/i.test(name) || name === CH_MANIFEST_NAME) continue;
                jsonFilesSeen++;
                if (onProgress && jsonFilesSeen % 25 === 0) onProgress({jsonFilesSeen,conversationJsonFiles,path:relativePath});

                const trackedId = trackedJsonPathToId.get(relativePath);
                if (trackedId) {
                    seenTrackedPaths.add(relativePath);
                    trackedFastChecked++;
                    const record = manifestById.get(trackedId);
                    try {
                        const file = await handle.getFile();
                        if (Number(record?.json_bytes || 0) > 0 && Number.isFinite(file?.size) && file.size !== Number(record.json_bytes)) {
                            errors.push({type:'MANIFEST_JSON_SIZE_MISMATCH',id:trackedId,path:relativePath,message:`tracked JSON size ${file.size} != manifest ${record.json_bytes}`});
                        }
                    } catch (err) {
                        errors.push({type:'MANIFEST_JSON_STAT_FAILED',id:trackedId,path:relativePath,message:err?.message || String(err)});
                    }
                    continue;
                }

                let data;
                try { data = await chReadJsonHandle(handle); }
                catch (_) { ignoredJsonFiles++; continue; }
                if (!chLooksLikeConversationJson(data)) { ignoredJsonFiles++; continue; }
                const id = String(data.conversation_id || data.id || '');
                if (!id) { errors.push({type:'RAW_CONVERSATION_ID_MISSING',id:null,path:relativePath,message:'conversation-shaped JSON has no conversation_id'}); continue; }
                conversationJsonFiles++;
                const rawRecord = {
                    conversation_id:id,title:data.title||'',create_time:data.create_time??null,
                    remote_update_time:data.update_time??null,is_archived:data.is_archived??false,
                    json_path:relativePath,tracking:'raw_only'
                };
                if (!rawById.has(id)) rawById.set(id,[]);
                rawById.get(id).push(rawRecord); rawByPath.set(relativePath,rawRecord);
            }
        };
        await walk(rootHandle,'');

        const blockedIds = new Set();
        for (const [id, record] of manifestById.entries()) {
            const trackedPath = String(record?.json_path || '');
            if (!trackedPath) { errors.push({type:'MANIFEST_JSON_PATH_MISSING',id,path:CH_MANIFEST_NAME,message:'tracked conversation has no json_path'}); blockedIds.add(id); continue; }
            if (!seenTrackedPaths.has(trackedPath)) { errors.push({type:'MANIFEST_JSON_NOT_FOUND',id,path:trackedPath,message:'manifest json_path was not found during archive scan'}); blockedIds.add(id); }
            if (record?.markdown_path) {
                const meta = await chRelativeFileMeta(rootHandle, record.markdown_path);
                if (!meta.exists) { errors.push({type:'MANIFEST_MARKDOWN_NOT_FOUND',id,path:record.markdown_path,message:'manifest markdown_path was not found during archive scan'}); blockedIds.add(id); }
                else if (Number(record?.markdown_bytes || 0)>0 && meta.size != null && meta.size !== Number(record.markdown_bytes)) {
                    errors.push({type:'MANIFEST_MARKDOWN_SIZE_MISMATCH',id,path:record.markdown_path,message:`tracked Markdown size ${meta.size} != manifest ${record.markdown_bytes}`});
                }
            }
            if (checkAssets && Array.isArray(record?.assets) && record.assets.length) {
                let missing = 0, sizeMismatch = 0;
                for (const asset of record.assets) {
                    if (!asset?.path) { missing++; assetIntegrityIssues++; continue; }
                    assetFastChecked++;
                    const meta = await chRelativeFileMeta(rootHandle, asset.path);
                    if (!meta.exists) { missing++; assetIntegrityIssues++; continue; }
                    const expectedSize = Number(asset?.size_bytes || 0);
                    if (expectedSize > 0 && meta.size != null && meta.size !== expectedSize) { sizeMismatch++; assetIntegrityIssues++; }
                }
                if (missing || sizeMismatch) {
                    record.__chAssetIntegrity = { missing, sizeMismatch };
                    record.attachment_state = 'partial';
                }
            }
        }

        const duplicateIds = new Set(); const duplicates=[];
        for (const [id, records] of rawById.entries()) if (records.length>1) { duplicateIds.add(id); duplicates.push({id,source:'local',paths:records.map(r=>r.json_path)}); blockedIds.add(id); }

        // A raw untracked copy with the same identity as a manifest-tracked conversation is not
        // silently adopted. Preserve it and block that identity until the duplicate is resolved.
        for (const [id, records] of rawById.entries()) {
            if (manifestById.has(id) && records.length) {
                duplicateIds.add(id); blockedIds.add(id);
                duplicates.push({id,source:'local-manifest+untracked',paths:[manifestById.get(id)?.json_path,...records.map(r=>r.json_path)].filter(Boolean)});
            }
        }

        const recordsById = new Map(manifestById);
        for (const [id, records] of rawById.entries()) {
            if (manifestById.has(id)) continue;
            if (records.length===1) recordsById.set(id,records[0]);
            else if (records.length>1) recordsById.set(id,{conversation_id:id,title:records[0]?.title||'',remote_update_time:records[0]?.remote_update_time??null,tracking:'duplicate_raw'});
        }

        const errorsById = new Map();
        for (const error of errors) { if (!error.id) continue; if (!errorsById.has(error.id)) errorsById.set(error.id,[]); errorsById.get(error.id).push(error); }
        for (const error of errors) if (error.id && /_NOT_FOUND|_SIZE_MISMATCH|_STAT_FAILED|_PATH_MISSING|_ID_MISMATCH/.test(error.type)) blockedIds.add(error.id);
        if (onProgress) onProgress({jsonFilesSeen,conversationJsonFiles,done:true});

        return {
            manifestExists:manifestResult.exists, manifestReadable:Boolean(manifestResult.manifest), manifest:manifestResult.manifest,
            recordsById,manifestById,rawById,duplicateIds,duplicates,blockedIds,errors,errorsById,
            stats:{
                local:recordsById.size,manifestTracked:manifestById.size,
                manifestProject:Array.from(manifestById.values()).filter(r=>r.project_id||r.project_title).length,
                manifestRoot:Array.from(manifestById.values()).filter(r=>!(r.project_id||r.project_title)).length,
                rawConversationFiles:conversationJsonFiles,rawUniqueIds:rawById.size,
                rawOnlyIds:Array.from(recordsById.values()).filter(r=>r.tracking==='raw_only').length,
                archiveLayoutVersion:manifestResult.manifest?chManifestLayoutVersion(manifestResult.manifest):CH_ARCHIVE_LAYOUT_VERSION,
                provider:manifestResult.manifest?(chManifestProvider(manifestResult.manifest)||CH_PROVIDER):CH_PROVIDER,
                migrationRequired:Boolean(manifestResult.manifest&&chManifestRequiresLayoutMigration(manifestResult.manifest)),
                jsonFilesSeen,ignoredJsonFiles,skippedAssetDirs,trackedFastChecked,assetFastChecked,assetIntegrityIssues
            }
        };
    }

    function chBuildPreflightPlan(remoteList, localScan, selectedIds = null, options = {}) {
        const allRemote = Array.isArray(remoteList) ? remoteList : [];
        const remoteUniverseComplete = options.remoteUniverseComplete !== false;
        const remoteUniverseNote = options.remoteUniverseNote || null;
        const includeAttachments = Boolean(options.includeAttachments);
        const retryFailedAttachments = Boolean(options.retryFailedAttachments);
        const selected = selectedIds instanceof Set && selectedIds.size > 0 ? selectedIds : null;

        const remoteById = new Map(); const remoteErrors=[];
        for (const entry of allRemote) {
            const id=chRemoteConversationId(entry);
            if(!id){remoteErrors.push({type:'REMOTE_ID_MISSING',id:null,title:entry?.title||'',message:'remote list entry has no conversation_id'});continue;}
            if(!remoteById.has(id))remoteById.set(id,[]); remoteById.get(id).push(entry);
        }
        const remoteDuplicateIds=new Set(),remoteDuplicates=[];
        for(const [id,entries] of remoteById.entries()) if(entries.length>1){remoteDuplicateIds.add(id);remoteDuplicates.push({id,source:'remote',count:entries.length,titles:entries.map(e=>e?.title||'')});}
        const duplicateIds=new Set([...localScan.duplicateIds,...remoteDuplicateIds]);
        const globalRemoteIds=new Set(remoteById.keys());
        const scopeIds=selected?new Set(Array.from(selected).filter(id=>globalRemoteIds.has(id))):new Set(globalRemoteIds);

        const items=[]; let newCount=0,remoteUpdateCandidateCount=0,renameCandidateCount=0,unchangedCount=0,metadataCandidateCount=0,rawOnlyVerifyCount=0,errorCount=0,maximumFetchRequired=0,attachmentCandidateCount=0;
        for(const id of scopeIds){
            const remoteEntries=remoteById.get(id)||[]; const remote=remoteEntries[0]||null; const local=localScan.recordsById.get(id)||null;
            if(duplicateIds.has(id)){items.push({id,action:'DUPLICATE',remote,local,needs_detail_fetch:false,reasons:[...(remoteDuplicateIds.has(id)?['REMOTE_DUPLICATE_ID']:[]),...(localScan.duplicateIds.has(id)?['LOCAL_DUPLICATE_ID']:[])]});continue;}
            if(localScan.blockedIds.has(id)){errorCount++;items.push({id,action:'ERROR',remote,local,needs_detail_fetch:false,reasons:(localScan.errorsById.get(id)||[]).map(e=>e.type)});continue;}
            if(!local){newCount++;maximumFetchRequired++;items.push({id,action:'NEW',remote,local:null,needs_detail_fetch:true,remote_update_candidate:false,rename_candidate:false,metadata_candidate:false,attachment_candidate:includeAttachments,reasons:['NOT_IN_LOCAL_ARCHIVE']});continue;}
            if(local.tracking!=='manifest'){
                const timeRelation=chTimeRelation(remote?.update_time,local?.remote_update_time);
                const updateCandidate=timeRelation!=='same'; const titleChanged=String(remote?.title||'')!==String(local?.title||'');
                rawOnlyVerifyCount++; if(updateCandidate)remoteUpdateCandidateCount++; if(titleChanged)renameCandidateCount++;
                items.push({id,action:'LOCAL_UNTRACKED',remote,local,needs_detail_fetch:false,requires_user_confirmation:true,remote_update_candidate:updateCandidate,rename_candidate:titleChanged,metadata_candidate:false,attachment_candidate:false,reasons:['LOCAL_RAW_NOT_MANIFEST_TRACKED',...(timeRelation==='different'?['REMOTE_UPDATE_TIME_DIFF']:timeRelation==='unknown'?['REMOTE_UPDATE_TIME_UNKNOWN']:[]),...(titleChanged?['TITLE_DIFF']:[])]});continue;
            }

            const baselineTitle=chRecordListTitle(local);
            const titleChanged=String(remote?.title||'')!==baselineTitle;
            const timeRelation=chTimeRelation(remote?.update_time,chRecordListUpdateTime(local));
            const unknownRecentlyVerified = timeRelation==='unknown' && Object.prototype.hasOwnProperty.call(local||{},'remote_list_update_time') && !normalizeEpochSeconds(remote?.update_time||0) && !normalizeEpochSeconds(local?.remote_list_update_time||0) && local?.remote_observed_at && (Date.now()-Date.parse(local.remote_observed_at)) < CH_REMOTE_FULL_REFRESH_MS;
            const updateCandidate=timeRelation==='different' || (timeRelation==='unknown' && !unknownRecentlyVerified);
            const metadataReasons=[];
            const archiveKnown=(remote?.__chArchiveState||'known')!=='unknown';
            const projectKnown=(remote?.__chProjectState||'known')!=='unknown';
            if(archiveKnown && Object.prototype.hasOwnProperty.call(remote||{},'is_archived') && Boolean(remote?.is_archived)!==Boolean(chRecordListArchiveState(local))) metadataReasons.push('ARCHIVE_STATE_DIFF');
            if(projectKnown && String(remote?.projectId??'')!==String(chRecordListProjectId(local)??'')) metadataReasons.push('PROJECT_ID_DIFF');
            if(projectKnown && String(remote?.projectTitle??'')!==String(chRecordListProjectTitle(local)??'')) metadataReasons.push('PROJECT_TITLE_DIFF');
            const metadataCandidate=metadataReasons.length>0;
            const attachmentState=chRecordAttachmentState(local);
            const attachmentCandidate=includeAttachments && chAttachmentNeedsAction(local, retryFailedAttachments);

            if(updateCandidate)remoteUpdateCandidateCount++; if(titleChanged)renameCandidateCount++; if(metadataCandidate)metadataCandidateCount++; if(attachmentCandidate)attachmentCandidateCount++;
            if(updateCandidate||titleChanged||metadataCandidate||attachmentCandidate){
                maximumFetchRequired++;
                items.push({id,action:(updateCandidate||metadataCandidate||attachmentCandidate)?'VERIFY_CHANGED':'VERIFY_RENAMED',remote,local,needs_detail_fetch:true,remote_update_candidate:updateCandidate,rename_candidate:titleChanged,metadata_candidate:metadataCandidate,attachment_candidate:attachmentCandidate,reasons:[...(timeRelation==='different'?['REMOTE_UPDATE_TIME_DIFF']:timeRelation==='unknown'?['REMOTE_UPDATE_TIME_UNKNOWN']:[]),...(titleChanged?['TITLE_DIFF']:[]),...metadataReasons,...(attachmentCandidate?[`ATTACHMENT_${attachmentState.toUpperCase()}`]:[])]});
            }else{
                unchangedCount++; items.push({id,action:'UNCHANGED',remote,local,needs_detail_fetch:false,remote_update_candidate:false,rename_candidate:false,metadata_candidate:false,attachment_candidate:false,reasons:[]});
            }
        }

        const localOnly=[];
        if(remoteUniverseComplete) for(const [id,local] of localScan.recordsById.entries()) if(!globalRemoteIds.has(id)&&!duplicateIds.has(id)&&!localScan.blockedIds.has(id))localOnly.push({id,local,action:'LOCAL_ONLY'});
        const attachmentStates={complete:0,partial:0,not_downloaded:0,unknown:0,none:0,failed:0};
        for(const record of localScan.manifestById?.values?.()||[]){
            const state=chRecordAttachmentState(record);
            if(Object.prototype.hasOwnProperty.call(attachmentStates,state))attachmentStates[state]++;
            attachmentStates.failed+=Array.isArray(record.attachment_failures)?record.attachment_failures.length:Number(record.attachment_failed||0);
        }
        return {items,localOnly,duplicateIds:Array.from(duplicateIds),duplicateDetails:[...localScan.duplicates,...remoteDuplicates],errors:[...localScan.errors,...remoteErrors],summary:{
            remote:allRemote.length,remoteUnique:remoteById.size,scopeRemote:scopeIds.size,local:localScan.recordsById.size,newCount,remoteUpdateCandidateCount,renameCandidateCount,unchangedCount,metadataCandidateCount,attachmentCandidateCount,rawOnlyVerifyCount,
            localOnlyCount:remoteUniverseComplete?localOnly.length:null,localOnlyReliable:remoteUniverseComplete,remoteUniverseComplete,remoteUniverseNote,duplicateIdCount:duplicateIds.size,
            errorCount:errorCount+remoteErrors.length+localScan.errors.filter(e=>!e.id).length,maximumFetchRequired,manifestTracked:localScan.stats.manifestTracked,localProjectCount:localScan.stats.manifestProject||0,localRootCount:localScan.stats.manifestRoot||0,archiveLayoutVersion:localScan.stats.archiveLayoutVersion,provider:localScan.stats.provider,migrationRequired:Boolean(localScan.stats.migrationRequired),rawConversationFiles:localScan.stats.rawConversationFiles,rawOnlyIds:localScan.stats.rawOnlyIds,trackedFastChecked:localScan.stats.trackedFastChecked||0,assetFastChecked:localScan.stats.assetFastChecked||0,assetIntegrityIssues:localScan.stats.assetIntegrityIssues||0,attachmentStates,attachmentProvenance:localScan.attachmentProvenance||chEmptyAttachmentProvenanceSummary(),includeAttachments,retryFailedAttachments
        }};
    }


    // Reports are independent of archive commits and never expire automatically.
    function chReportStorageNotice(message, failed = false) {
        const el = document.getElementById('ch-report-storage-status');
        if (el) { el.textContent = message; el.style.color = failed ? '#b91c1c' : '#6b7280'; }
        if (failed) console.warn('[ChatHarbor report]', message);
    }

    function chSafeReportText(text) {
        return String(text)
            .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]')
            .replace(/([?&][\w.-]+=)[^\s&#"']*/g, '$1[REDACTED]')
            .replace(/((?:access_token|refresh_token|authorization|cookie)\s*[:=]\s*)[^\r\n]+/gi, '$1[REDACTED]');
    }

    async function chPersistOperationReport(rootHandle, type, detailText) {
        try {
            const dir = await rootHandle.getDirectoryHandle('reports', { create: true });
            const name = `${new Date().toISOString().replace(/[:.]/g, '-')}_${type}_${crypto.randomUUID()}.txt`;
            try {
                await dir.getFileHandle(name);
                throw new Error('Report filename already exists');
            } catch (err) { if (err.name !== 'NotFoundError') throw err; }
            const payload = chSafeReportText(detailText);
            const handle = await chWriteRawFile(dir, name, payload);
            if (await (await handle.getFile()).text() !== payload) throw new Error('Report read-back mismatch');
            chReportStorageNotice(chT('报告已保存：','Report saved: ') + `reports/${name}`);
            return name;
        } catch (err) {
            chReportStorageNotice(chT('报告保存失败；归档结果不受影响：','Report save failed; archive result is unchanged: ') + chSafeReportText(err.message || String(err)), true);
            return null;
        }
    }

    async function chOpenReportHistory(rootHandle) {
        try {
            const dir = await rootHandle.getDirectoryHandle('reports');
            const names = [];
            for await (const [name, handle] of dir.entries()) if (handle.kind === 'file' && name.endsWith('.txt')) names.push(name);
            names.sort().reverse();
            if (!names.length) { window.alert(chT('暂无已保存报告。','No saved reports.')); return; }
            const box = document.createElement('div');
            box.id = 'ch-report-history-overlay';
            Object.assign(box.style, {position:'fixed',inset:'8%',zIndex:'100000',background:'#fff',color:'#1f2937',padding:'16px',border:'1px solid #9ca3af',boxShadow:'0 12px 40px #0005',display:'flex',flexDirection:'column',gap:'10px'});
            const heading = document.createElement('strong'); heading.textContent = chT('历史报告（永久保留）','Report history (no expiry)');
            const select = document.createElement('select'); select.setAttribute('aria-label',chT('选择历史报告','Choose saved report'));
            Object.assign(select.style,{border:'1px solid #9ca3af',padding:'8px',background:'#fff',color:'#1f2937'});
            for (const name of names) { const option = document.createElement('option'); option.value=name; option.textContent=name; select.appendChild(option); }
            const pre = document.createElement('pre'); Object.assign(pre.style,{overflow:'auto',whiteSpace:'pre-wrap',flex:'1',fontSize:'12px'});
            const close = document.createElement('button'); close.textContent=chT('关闭','Close'); close.onclick=()=>box.remove();
            select.onchange = async () => {
                const name = select.value;
                try { const value = await (await (await dir.getFileHandle(name)).getFile()).text(); if (select.value === name) pre.textContent=value; }
                catch(err) { pre.textContent=chSafeReportText(err.message || String(err)); }
            };
            box.append(heading,select,pre,close); document.body.appendChild(box); await select.onchange(); close.focus();
        } catch (err) {
            window.alert(err.name === 'NotFoundError' ? chT('暂无已保存报告。','No saved reports.') : chSafeReportText(err.message || String(err)));
        }
    }

    function chRenderInlineReport(title, summaryLines, detailText, tone = 'success') {
        const panel = document.getElementById('ch-result-panel');
        const titleEl = document.getElementById('ch-result-title');
        const summaryEl = document.getElementById('ch-result-summary');
        const copyBtn = document.getElementById('ch-copy-report-btn');
        if (!panel || !titleEl || !summaryEl) {
            console.log(`[ChatHarbor] ${title}\n${detailText || summaryLines.join('\n')}`);
            return;
        }
        panel.style.display = 'block';
        panel.style.background = tone === 'error' ? '#fef2f2' : tone === 'warn' ? '#fffbeb' : '#f0fdf4';
        panel.style.borderColor = tone === 'error' ? '#fecaca' : tone === 'warn' ? '#fde68a' : '#bbf7d0';
        titleEl.textContent = title;
        summaryEl.textContent = summaryLines.join('\n');
        if (copyBtn) copyBtn.onclick = async () => {
            const payload = detailText || summaryLines.join('\n');
            try { await navigator.clipboard.writeText(payload); copyBtn.textContent = chT('已复制','Copied'); setTimeout(()=>copyBtn.textContent=chT('复制详细报告','Copy details'),1200); }
            catch (_) { console.log(payload); }
        };
    }

    function chFormatLocalTimestamp(value = Date.now()) {
        const d = value instanceof Date ? value : new Date(value);
        if (Number.isNaN(d.getTime())) return 'Unknown';
        const pad = n => String(n).padStart(2, '0');
        const offsetMinutes = -d.getTimezoneOffset();
        const sign = offsetMinutes >= 0 ? '+' : '-';
        const abs = Math.abs(offsetMinutes);
        const offset = `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
        return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${offset}`;
    }

    function chAttachmentPolicyReport(includeAttachments, retryFailedAttachments) {
        if (!includeAttachments) return { policy: 'excluded', description: chT('不下载附件 / 附件未纳入本次同步判断','Do not download attachments / excluded from this sync check') };
        if (retryFailedAttachments) return { policy: 'include_known_failures', description: chT('下载新附件，并显式重试历史已知失败附件','Download new attachments and explicitly retry known historical failures') };
        return { policy: 'new_or_unattempted_only', description: chT('下载新/未尝试附件；历史失败默认不重试','Download new/unattempted attachments; historical failures are not retried by default') };
    }

    function chAttachmentFailureStage(error) {
        const value = String(error || '');
        if (/^metadata HTTP\s+/i.test(value)) return 'metadata';
        if (/download_url/i.test(value)) return 'download_url';
        if (/^binary HTTP\s+/i.test(value)) return 'binary';
        return 'other';
    }

    function chAttachmentRunSummary(result) {
        const reports = (result?.sync?.results || []).map(x => x?.attachmentReport).filter(Boolean);
        const failures = reports.flatMap(x => Array.isArray(x.failures) ? x.failures.map(f => ({ ...f, conversation_id: x.conversation_id, title: x.title })) : []);
        return {
            failures,
            detected: reports.reduce((n,x)=>n+Number(x.detected||0),0),
            attempted: reports.reduce((n,x)=>n+Number(x.attempted||0),0),
            downloaded: reports.reduce((n,x)=>n+Number(x.downloaded||0),0),
            failed: failures.length,
            firstFailures: failures.filter(x => !x.was_known_failure).length,
            retriedFailures: failures.filter(x => x.was_known_failure).length
        };
    }

    function chAttachmentFailureReasonLines(failures) {
        const counts = new Map();
        for (const failure of failures || []) {
            const key = String(failure?.error || chT('未知错误','Unknown error'));
            counts.set(key, (counts.get(key) || 0) + 1);
        }
        return [...counts.entries()].sort((a,b)=>a[0].localeCompare(b[0])).map(([reason,count])=>`${reason}: ${count}`);
    }


    function chAttachmentErrorInfo(error) {
        const value = String(error || '');
        let match = value.match(/(?:metadata|binary) HTTP\s+(\d{3})/i);
        if (match) {
            const code = match[1];
            const explanations = {
                '403': chT('ChatGPT 服务器拒绝了当前访问请求。可能与权限、资源访问策略或当前会话上下文有关；不代表文件一定不存在。','ChatGPT refused the current request. This may involve permission, resource policy, or conversation context; it does not prove the file is absent.'),
                '404': chT('ChatGPT 当前接口未找到该资源。可能涉及资源生命周期、存储位置变化或当前接口无法解析；不能仅据此确认文件已永久删除。','The current ChatGPT endpoint did not find this resource. This may involve resource lifecycle, storage changes, or endpoint resolution; it does not prove permanent deletion.'),
                '415': chT('ChatGPT 的内容交付接口未接受或未正确处理当前资源形式，可能涉及文件类型、MIME 类型或交付链兼容性；不代表文件内容已经损坏。','The ChatGPT content-delivery endpoint did not accept or correctly handle this resource form. File type, MIME type, or delivery compatibility may be involved; this does not prove corruption.'),
                '500': chT('ChatGPT 服务端处理请求时发生错误，通常表示服务端异常；可能具有临时性。','ChatGPT encountered a server-side processing error. This is typically a server error and may be temporary.')
            };
            return { short: code, explanation: explanations[code] || chT(`ChatGPT 返回 HTTP ${code}。保留原始状态码供核查。`,`ChatGPT returned HTTP ${code}. The raw status is preserved for review.`) };
        }
        if (/download_url.*(?:missing|expired)|missing or expired/i.test(value)) {
            return { short: chT('URL失效','URL unavailable'), explanation: chT('ChatGPT 当前没有提供可用下载地址，或临时下载地址已经失效。仅凭这一结果无法判断资源本身是否仍然存在。','ChatGPT did not provide a usable download URL, or a temporary URL expired. This alone cannot establish whether the resource still exists.') };
        }
        return { short: value || chT('未知','Unknown'), explanation: chT('保留平台或下载链路返回的原始错误；当前没有更具体的解释。','The original platform/download-path error is preserved; no more specific interpretation is available.') };
    }

    function chAttachmentProvenanceReportLines(summary) {
        const s = summary || chEmptyAttachmentProvenanceSummary();
        const sourceOrder = ['user_upload','assistant_generated_deliverable','generated_media','assistant_asset','unknown'];
        const lines = [
            `【${chT('历史未成功归档附件','Historical attachments not successfully archived')}】`,
            `${chT('总计','Total')}: ${Number(s.failedTotal||0)}`,
            `${chT('按来源','By source')}:`
        ];
        sourceOrder.forEach(source => lines.push(`- ${chAttachmentSourceLabel(source)}: ${Number(s.failedBySource?.[source]||0)}`));
        lines.push(`${chT('按资源通道','By reference kind')}:`);
        for (const [key,count] of Object.entries(s.failedByKind||{})) lines.push(`- ${key}: ${count}`);
        lines.push(`${chT('按失败阶段','By failure stage')}:`);
        for (const [key,count] of Object.entries(s.failedByStage||{})) lines.push(`- ${key}: ${count}`);
        lines.push(`${chT('按失败原因','By failure reason')}:`);
        for (const [key,count] of Object.entries(s.failedByError||{})) lines.push(`- ${count} × ${key}`);
        lines.push(`【${chT('来源 × 失败原因','Source × failure reason')}】`);
        for (const source of sourceOrder) {
            const errors = s.sourceByError?.[source] || {};
            const entries = Object.entries(errors);
            if (!entries.length) continue;
            lines.push(`${chAttachmentSourceLabel(source)}:`);
            entries.forEach(([error,count]) => lines.push(`  ${count} × ${error}`));
        }
        lines.push(`${chT('来源未知','Unknown source')}: ${Number(s.unknownFailures||0)}`);
        if (Number(s.unknownFailures||0)) lines.push(`${chT('提示','Note')}: ${chT('旧记录缺少来源信息时保持 Unknown；历史来源补全应使用独立 Backfill/Migration Tool。','Legacy records without provenance remain Unknown; use the standalone Backfill/Migration Tool for historical provenance.')}`);
        return lines;
    }

    function chPreflightReportText(plan) {
        const s = plan.summary;
        const ctx = plan.reportContext || {};
        const policy = chAttachmentPolicyReport(Boolean(s.includeAttachments), Boolean(s.retryFailedAttachments));
        const lines = [
            `${chT('ChatHarbor','ChatHarbor')} v${CH_PRODUCT_VERSION}｜${chT('目录扫描 + 同步预检','Archive Scan + Preflight')}`, '',
            `【${chT('报告信息','Report information')}】`,
            `${chT('报告类型','Report type')}: LOCAL_PREFLIGHT`,
            `${chT('扫描开始','Scan started')}: ${chFormatLocalTimestamp(ctx.scan_started_at)}`,
            `${chT('扫描结束','Scan finished')}: ${chFormatLocalTimestamp(ctx.scan_finished_at)}`,
            `${chT('报告生成','Report generated')}: ${chFormatLocalTimestamp()}`,
            `${chT('报告阶段','Report stage')}: ${chT('本地目录扫描 + 同步预检','Local archive scan + sync preflight')}`,
            `${chT('状态来源','State source')}: fresh local scan + current remote index`,
            `${chT('触发方式','Trigger')}: local preflight scan`, '',
            `【${chT('附件策略','Attachment policy')}】`,
            `includeAttachments: ${Boolean(s.includeAttachments)}`,
            `retryFailedAttachments: ${Boolean(s.retryFailedAttachments)}`,
            `policy: ${policy.policy}`,
            `${chT('说明','Description')}: ${policy.description}`, '',
            `【${chT('预检结果','Preflight result')}】`,
            chT('只读：未抓取对话详情，未写入任何文件或 Manifest。','Read-only: no conversation detail fetch and no disk/manifest write.'),
            `Remote: ${s.remote} (${s.remoteUnique} unique IDs)`,
            `${chT('远端全集','Remote universe')}: ${s.remoteUniverseComplete ? chT('完整','COMPLETE') : chT('不完整','INCOMPLETE')}`,
            ...(s.remoteUniverseNote ? [`${chT('远端备注','Remote note')}: ${s.remoteUniverseNote}`] : []),
            `${chT('本地','Local')}: ${s.local}`,
            `${chT('新增','NEW')}: ${s.newCount}`,
            `${chT('远端更新时间候选','remote-update candidates')}: ${s.remoteUpdateCandidateCount}`,
            `${chT('改名候选','rename candidates')}: ${s.renameCandidateCount}`,
            `${chT('已同步','UNCHANGED')}: ${s.unchangedCount}`,
            `${chT('元数据候选','metadata candidates')}: ${s.metadataCandidateCount}`,
            `${chT('附件候选','attachment candidates')}: ${s.attachmentCandidateCount||0}`,
            `${chT('本地未跟踪待核验','raw-only verify candidates')}: ${s.rawOnlyVerifyCount}`,
            `${chT('仅本地','LOCAL_ONLY')}: ${s.localOnlyReliable ? s.localOnlyCount : chT('未知（远端全集不完整）','UNKNOWN (remote universe incomplete)')}`,
            `${chT('重复ID','duplicate IDs')}: ${s.duplicateIdCount}`,
            `${chT('错误','ERROR')}: ${s.errorCount}`,
            `${chT('最多需要抓取详情','maximum fetch required')}: ${s.maximumFetchRequired}`, '',
            `【${chT('当前本地附件状态','Current local attachment state')}】`,
            `${chT('完整会话','Complete conversations')}: ${s.attachmentStates?.complete||0}`,
            `${chT('不完整会话','Partial conversations')}: ${s.attachmentStates?.partial||0}`,
            `${chT('已知失败附件','Known failed attachments')}: ${s.attachmentStates?.failed||0}`,
            `${chT('Manifest 跟踪附件路径','Manifest tracked attachment paths')}: ${s.assetFastChecked||0}`,
            `${chT('附件缺失/异常','Attachment issues')}: ${s.assetIntegrityIssues||0}`, '',
            `${chT('Manifest 跟踪','Manifest tracked')}: ${s.manifestTracked}`,
            `${chT('Manifest 快检','Manifest fast-checked')}: ${s.trackedFastChecked||0}`,
            `${chT('原始对话 JSON','Raw conversation JSON files')}: ${s.rawConversationFiles}`,
            `${chT('仅原始文件 ID','Raw-only IDs')}: ${s.rawOnlyIds}`, ''
        ];
        lines.push(...chAttachmentProvenanceReportLines(s.attachmentProvenance));
        lines.push('', chT('本次扫描未执行附件下载，无本轮附件失败记录。','This scan did not download attachments; there are no per-run attachment failure records.'));
        if (plan.errors.length) {
            lines.push('', `=== ${chT('扫描错误','SCAN ERRORS')} (${plan.errors.length}) ===`);
            for (const error of plan.errors.slice(0,80)) lines.push(`[${error.type}] ${error.id||'-'} | ${error.path||'-'} | ${error.message||''}`);
        }
        return lines.join('\n');
    }

    function chShowPreflightReport(plan) {
        const detail = chPreflightReportText(plan);
        const btn = document.getElementById('ch-archive-copy-report-btn');
        if (btn) btn.onclick = () => {
            const s = plan.summary;
            const pending = Math.max(0, Number(s.maximumFetchRequired || 0));
            const remoteConfirm = Math.max(0, Number(s.rawOnlyVerifyCount || 0));
            const localOnly = s.localOnlyReliable ? Math.max(0, Number(s.localOnlyCount || 0)) : 0;
            const issues = Math.max(0, Number(s.errorCount || 0) + Number(s.duplicateIdCount || 0));
            const summaryLines = [
                `${chT('本地记录','Local records')} ${s.local || 0} · ${chT('已跟踪','Tracked')} ${s.manifestTracked || 0} · ${chT('未跟踪','Untracked')} ${s.rawOnlyIds || 0}`,
                `${chT('云端列表','Remote list')}：${chT('已同步','Synced')} ${s.unchangedCount || 0} · ${chT('待同步','To sync')} ${pending} · ${chT('需确认','Check')} ${remoteConfirm} · ${chT('异常','Error')} ${issues}`
            ];
            if (localOnly) summaryLines.push(`${chT('仅本地记录','Local-only records')} ${localOnly} · ${chT('不在云端列表，需确认','not in the remote list; review required')}`);
            chRenderInlineReport(chT('本地检查详情','Local check details'),summaryLines,detail,issues?'warn':'success');
        };
        const resultPanel = document.getElementById('ch-result-panel');
        if (resultPanel && !chSyncRun.active) resultPanel.style.display = 'none';
    }

    async function chRunPreflightPlanner({ rootHandle, remoteList, selectedIds = null, remoteUniverseComplete = true, remoteUniverseNote = null, includeAttachments = false, retryFailedAttachments = false }) {
        const scanStartedAt = new Date().toISOString();
        chSetProgress('快速检查', '只读检查本地文件…', 0);
        const localScan = await chScanLocalArchiveReadOnly(rootHandle, info => {
            const seen = info.jsonFilesSeen || 0;
            const found = info.conversationJsonFiles || 0;
            chSetProgress(
                '快速检查 · 本地扫描',
                `已检查 JSON ${seen} · 识别对话 ${found}${info.path ? ` · ${info.path}` : ''}`,
                null
            );
        }, { checkAssets: true });
        if (localScan.manifest && chManifestRequiresLayoutMigration(localScan.manifest)) {
            throw new Error('Archive Layout v1 需要先执行纯本地 Layout v2 升级。');
        }
        chSummarizeLocalAttachmentProvenance(localScan);

        chSetProgress('快速检查', '生成同步计划（不抓取详情、不写盘）…', 70);
        const plan = chBuildPreflightPlan(remoteList, localScan, selectedIds, {
            remoteUniverseComplete,
            remoteUniverseNote,
            includeAttachments,
            retryFailedAttachments
        });
        plan.reportContext = { type: 'LOCAL_PREFLIGHT', scan_started_at: scanStartedAt, scan_finished_at: new Date().toISOString(), includeAttachments: Boolean(includeAttachments), retryFailedAttachments: Boolean(retryFailedAttachments) };
        const s = plan.summary;
        const pending = Math.max(0, Number(s.maximumFetchRequired || 0));
        const confirm = Math.max(0, Number(s.rawOnlyVerifyCount || 0)) + (s.localOnlyReliable ? Math.max(0, Number(s.localOnlyCount || 0)) : 0);
        const issues = Math.max(0, Number(s.errorCount || 0) + Number(s.duplicateIdCount || 0));
        const summaryParts = [`${chT('待同步','To sync')} ${pending}`, `${chT('已同步','Synced')} ${s.unchangedCount || 0}`];
        if (confirm) summaryParts.push(`${chT('需确认','Check')} ${confirm}`);
        if (issues) summaryParts.push(`${chT('异常','Error')} ${issues}`);
        chSetProgress(chT('快速检查完成','Quick check complete'), summaryParts.join(' · '), 100);
        chShowPreflightReport(plan);
        console.log('[ChatHarbor Integrated Sync] Preflight plan (read-only):', { localScan, plan });
        return { localScan, plan };
    }

    // ======================== ChatHarbor Integrated Version-aware Sync ========================
    // Version-aware sync reuses the shared discovery/detail/Markdown/attachment primitives and
    // the validated archive writer/Manifest invariants above.

    const CH_FINAL_SYNC_ACTIONS = new Set([
        'NEW',
        'UPDATED',
        'RENAMED_ONLY',
        'UPDATED_AND_RENAMED',
        'METADATA_ONLY',
        'ATTACHMENT_BACKFILL',
        'OBSERVATION_ONLY'
    ]);

    function chMergeRemoteEntries(entries) {
        const merged=new Map();
        for(const entry of Array.isArray(entries)?entries:[]){
            const id=chRemoteConversationId(entry); if(!id)continue;
            const normalized={...entry,id}; const existing=merged.get(id);
            if(!existing){merged.set(id,normalized);continue;}
            const existingTime=normalizeEpochSeconds(existing.update_time||0), incomingTime=normalizeEpochSeconds(normalized.update_time||0);
            const newer=incomingTime>existingTime?normalized:incomingTime<existingTime?existing:normalized;
            const older=newer===normalized?existing:normalized;
            const archiveA=existing.__chArchiveState||'known',archiveB=normalized.__chArchiveState||'known';
            const archiveConflict=archiveA==='known'&&archiveB==='known'&&Boolean(existing.is_archived)!==Boolean(normalized.is_archived)&&existingTime===incomingTime;
            const projectStateA=existing.__chProjectState||((existing.projectId||existing.projectTitle)?'known':'unknown');
            const projectStateB=normalized.__chProjectState||((normalized.projectId||normalized.projectTitle)?'known':'unknown');
            const projectKnownA=projectStateA==='known',projectKnownB=projectStateB==='known';
            const projectConflict=projectKnownA&&projectKnownB&&String(existing.projectId??'')!==String(normalized.projectId??'');
            const resolvedProject=projectConflict
                ? {id:null,title:null,state:'unknown'}
                : projectKnownB
                    ? {id:normalized.projectId??null,title:normalized.projectTitle??null,state:'known'}
                    : projectKnownA
                        ? {id:existing.projectId??null,title:existing.projectTitle??null,state:'known'}
                        : (projectStateA==='none'||projectStateB==='none')
                            ? {id:null,title:null,state:'none'}
                            : {id:null,title:null,state:'unknown'};
            merged.set(id,{
                ...older,...newer,id,
                projectId:resolvedProject.id,
                projectTitle:resolvedProject.title,
                __chProjectState:resolvedProject.state,
                is_archived:archiveConflict?Boolean(newer.is_archived):Boolean(newer.is_archived),
                __chArchiveState:archiveConflict?'unknown':((newer.__chArchiveState||'known')==='unknown'?(older.__chArchiveState||'unknown'):'known'),
                create_time:newer.create_time||older.create_time||0,
                update_time:Math.max(existingTime,incomingTime)||newer.update_time||older.update_time||0
            });
        }
        return Array.from(merged.values());
    }

    const chRemoteRefreshFlights = new Map();

    function chRemoteCacheIdentity(workspaceId = null) {
        // Persistent cache must never guess across accounts. An explicit workspace is safe;
        // otherwise prefer the active account cookie and only fall back when exactly one
        // workspace identity is detectable. Ambiguous identity disables persistence.
        if (workspaceId) {
            const explicit = resolveWorkspaceId(workspaceId);
            return explicit ? `${CH_PROVIDER}:${explicit}` : null;
        }
        const cookieMatch = document.cookie.match(/(?:^|; )_account=([^;]+)/);
        if (cookieMatch?.[1]) return `${CH_PROVIDER}:${cookieMatch[1]}`;
        const detected = detectAllWorkspaceIds();
        return detected.length === 1 ? `${CH_PROVIDER}:${detected[0]}` : null;
    }

    function chOpenRemoteCacheDb() {
        return new Promise((resolve,reject)=>{
            if(typeof indexedDB==='undefined'){resolve(null);return;}
            const req=indexedDB.open(CH_REMOTE_CACHE_DB,1);
            req.onupgradeneeded=()=>{const db=req.result;if(!db.objectStoreNames.contains(CH_REMOTE_CACHE_STORE))db.createObjectStore(CH_REMOTE_CACHE_STORE,{keyPath:'key'});};
            req.onsuccess=()=>resolve(req.result); req.onerror=()=>reject(req.error||new Error('IndexedDB open failed'));
        });
    }

    async function chRemoteCacheGet(workspaceId = null) {
        const key=chRemoteCacheIdentity(workspaceId); if(!key)return null;
        try{const db=await chOpenRemoteCacheDb();if(!db)return null;return await new Promise((resolve,reject)=>{const tx=db.transaction(CH_REMOTE_CACHE_STORE,'readonly');const req=tx.objectStore(CH_REMOTE_CACHE_STORE).get(key);req.onsuccess=()=>resolve(req.result||null);req.onerror=()=>reject(req.error);});}catch(err){console.warn('[ChatHarbor] remote cache read failed',err);return null;}
    }

    async function chRemoteCachePut(workspaceId, snapshot) {
        const key=chRemoteCacheIdentity(workspaceId); if(!key)return false;
        try{const db=await chOpenRemoteCacheDb();if(!db)return false;const value={...snapshot,key,schema:CH_REMOTE_CACHE_SCHEMA,provider:CH_PROVIDER};await new Promise((resolve,reject)=>{const tx=db.transaction(CH_REMOTE_CACHE_STORE,'readwrite');tx.objectStore(CH_REMOTE_CACHE_STORE).put(value);tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||new Error('cache transaction aborted'));});return true;}catch(err){console.warn('[ChatHarbor] remote cache write failed',err);return false;}
    }

    function chHeadFingerprintEntry(entry) {
        return [entry.__chSourceKey||'',chRemoteConversationId(entry),String(entry.title||''),normalizeEpochSeconds(entry.update_time||0),entry.__chArchiveState||'unknown',entry.is_archived===true?'1':entry.is_archived===false?'0':'?',entry.__chProjectState||'unknown',String(entry.projectId??''),String(entry.projectTitle??'')].join('|');
    }

    function chHeadFingerprint(entries) {
        return (entries||[]).map(chHeadFingerprintEntry).sort().join('\n');
    }

    async function chRemoteHeaders(workspaceId = null) {
        if(!await ensureAccessToken())throw new Error('无法获取 Access Token。');
        const deviceId=getOaiDeviceId(); if(!deviceId)throw new Error('无法获取 oai-device-id。');
        const headers={'Authorization':`Bearer ${accessToken}`,'oai-device-id':deviceId};
        const resolved=resolveWorkspaceId(workspaceId); if(resolved)headers['ChatGPT-Account-Id']=resolved;
        return headers;
    }

    async function chFetchRootHead(workspaceId = null, limit = CH_REMOTE_HEAD_LIMIT, options = {}) {
        const headers=await chRemoteHeaders(workspaceId); const entries=[];
        for(const archived of [false,true]){
            options.onProgress?.({stage:'head-root',message:`快速核对${archived?'已归档':'未归档'}列表…`});
            const r=await chBackendFetch(`/backend-api/conversations?offset=0&limit=${limit}&order=updated${archived?'&is_archived=true':''}`,{headers});
            if(!r.ok)throw new Error(`远端列表快速刷新失败 (${r.status})`);
            const j=await r.json();
            for(const item of j.items||[])entries.push({id:item.id,title:item.title||'Untitled Conversation',create_time:normalizeEpochSeconds(item.create_time||0),update_time:normalizeEpochSeconds(item.update_time||item.create_time||0),is_archived:archived,projectId:null,projectTitle:null,__chArchiveState:'known',__chProjectState:'unknown',__chSourceKey:`root:${archived?'archived':'active'}`});
        }
        return entries;
    }

    async function chFetchProjectHead(workspaceId = null, limit = CH_REMOTE_HEAD_LIMIT, options = {}) {
        const resolved=resolveWorkspaceId(workspaceId);
        options.onProgress?.({stage:'head-project',message:'快速核对项目列表…'});
        const projects=await getProjectSpaces(resolved,{conversationsPerGizmo:limit,ownedOnly:true}); const entries=[];
        for(const project of projects)for(const item of project.conversations||[])entries.push({id:item.id,title:item.title||'Untitled Conversation',create_time:normalizeEpochSeconds(item.create_time||0),update_time:normalizeEpochSeconds(item.update_time||item.create_time||0),is_archived:item.is_archived??false,projectId:project.id,projectTitle:project.title,__chArchiveState:Object.prototype.hasOwnProperty.call(item||{},'is_archived')?'known':'unknown',__chProjectState:'known',__chSourceKey:`project:${project.id}`});
        return entries;
    }

    async function chFetchRemoteHeadSnapshot(workspaceId = null, options = {}) {
        const entries=[...(await chFetchRootHead(workspaceId,CH_REMOTE_HEAD_LIMIT,options)),...(await chFetchProjectHead(workspaceId,CH_REMOTE_HEAD_LIMIT,options))];
        return {entries,fingerprint:chHeadFingerprint(entries),validatedAt:Date.now()};
    }

    async function chFetchRootFull(workspaceId = null, options = {}) {
        const headers=await chRemoteHeaders(workspaceId); const entries=[];
        for(const archived of [false,true]){
            let offset=0,hasMore=true,page=0;
            while(hasMore){
                page+=1;
                options.onProgress?.({stage:'root',archived,page,message:`读取${archived?'已归档':'未归档'}对话 · 第 ${page} 页…`});
                const r=await chBackendFetch(`/backend-api/conversations?offset=${offset}&limit=${PAGE_LIMIT}&order=updated${archived?'&is_archived=true':''}`,{headers});
                if(!r.ok)throw new Error(`远端列表完整刷新失败 (${r.status})`);
                const j=await r.json(); const items=Array.isArray(j.items)?j.items:[];
                for(const item of items)entries.push({id:item.id,title:item.title||'Untitled Conversation',create_time:normalizeEpochSeconds(item.create_time||0),update_time:normalizeEpochSeconds(item.update_time||item.create_time||0),is_archived:archived,projectId:null,projectTitle:null,__chArchiveState:'known',__chProjectState:'unknown',__chSourceKey:`root:${archived?'archived':'active'}`});
                hasMore=items.length===PAGE_LIMIT; offset+=items.length;
                options.onPartial?.({list:chMergeRemoteEntries(entries),complete:false,note:`root ${entries.length} · project complement pending`,validatedAt:0,refreshMode:'partial-root'});
            }
        }
        return chMergeRemoteEntries(entries);
    }

    async function chFetchProjectFull(workspaceId = null, options = {}) {
        const resolved=resolveWorkspaceId(workspaceId);
        const headers=await chRemoteHeaders(resolved);
        options.onProgress?.({stage:'projects',message:'读取项目列表…'});
        const projects=await getProjectSpaces(resolved,{conversationsPerGizmo:PROJECT_SIDEBAR_PREVIEW,ownedOnly:true});
        const entries=[];
        for(let projectIndex=0;projectIndex<projects.length;projectIndex++){
            const project=projects[projectIndex];
            let cursor='0'; let fetched=false;
            options.onProgress?.({stage:'projects',current:projectIndex+1,total:projects.length,message:`读取项目 ${projectIndex+1}/${projects.length} · ${project.title}`});
            do{
                const r=await chBackendFetch(`/backend-api/gizmos/${project.id}/conversations?cursor=${cursor}`,{headers});
                if(!r.ok){
                    if(!fetched&&Array.isArray(project.conversations)&&project.conversations.length){
                        project.conversations.forEach(item=>entries.push({id:item.id,title:item.title||'Untitled Conversation',create_time:normalizeEpochSeconds(item.create_time||0),update_time:normalizeEpochSeconds(item.update_time||item.create_time||0),is_archived:item.is_archived??false,projectId:project.id,projectTitle:project.title,__chArchiveState:Object.prototype.hasOwnProperty.call(item||{},'is_archived')?'known':'unknown',__chProjectState:'known',__chSourceKey:`project:${project.id}`}));
                        cursor=null; break;
                    }
                    throw new Error(`列举项目对话列表失败 (${r.status})`);
                }
                const j=await r.json();
                for(const item of j.items||[])entries.push({id:item.id,title:item.title||'Untitled Conversation',create_time:normalizeEpochSeconds(item.create_time||0),update_time:normalizeEpochSeconds(item.update_time||item.create_time||0),is_archived:item.is_archived??false,projectId:project.id,projectTitle:project.title,__chArchiveState:Object.prototype.hasOwnProperty.call(item||{},'is_archived')?'known':'unknown',__chProjectState:'known',__chSourceKey:`project:${project.id}`});
                cursor=j.cursor||null; fetched=true;
            }while(cursor);
            options.onProjectPartial?.(entries.slice(),{current:projectIndex+1,total:projects.length,project});
        }
        options.onProjectSummary?.({projects:projects.length,projectConversations:entries.length,accountIdentityResolved:Boolean(resolved)});
        return chMergeRemoteEntries(entries);
    }

    async function chFetchFullRemoteUniverse(workspaceId = null, options = {}) {
        const rootList=await chFetchRootFull(workspaceId,{
            onProgress:options.onProgress,
            onPartial:partial=>options.onPartial?.(partial)
        });
        options.onPartial?.({list:rootList,complete:false,note:`root complete ${rootList.length} · project complement pending`,validatedAt:0,refreshMode:'partial-root-complete'});
        let projectList=[]; let complete=true; let note=null; let projectSummary={projects:0,projectConversations:0,accountIdentityResolved:Boolean(resolveWorkspaceId(workspaceId))};
        try{
            projectList=await chFetchProjectFull(workspaceId,{
                onProgress:options.onProgress,
                onProjectPartial:(partialProjects,meta)=>{
                    const merged=chMergeRemoteEntries(rootList.concat(partialProjects)).map(item=>({...item,__chProjectState:(item.projectId||item.projectTitle)?'known':'unknown',__chArchiveState:item.__chArchiveState||'unknown'}));
                    options.onPartial?.({list:merged,complete:false,note:`root ${rootList.length} · projects ${meta.current}/${meta.total}`,validatedAt:0,refreshMode:'partial-projects'});
                },
                onProjectSummary:summary=>{projectSummary=summary;}
            });
        }catch(err){complete=false;note=`project complement failed: ${err?.message||String(err)}`;}
        const merged=chMergeRemoteEntries(rootList.concat(projectList)).map(item=>({...item,__chProjectState:(item.projectId||item.projectTitle)?'known':complete?'none':'unknown',__chArchiveState:item.__chArchiveState||'unknown'}));
        return {list:merged,complete,note:note||`root=${rootList.length} · projects=${projectSummary.projects} · projectConversations=${projectSummary.projectConversations} · accountIdentityResolved=${projectSummary.accountIdentityResolved?'yes':'no'}`};
    }

    async function chRefreshRemoteIndex(workspaceId = null, { forceFull = false, onProgress = null, onPartial = null } = {}) {
        const flightKey=chRemoteCacheIdentity(workspaceId)||`volatile:${workspaceId||'default'}`;
        if(chRemoteRefreshFlights.has(flightKey))return chRemoteRefreshFlights.get(flightKey);
        const callbacks={onProgress,onPartial};
        const promise=(async()=>{
            const cached=await chRemoteCacheGet(workspaceId); const now=Date.now();
            const needsPeriodicFull=!cached||cached.schema!==CH_REMOTE_CACHE_SCHEMA||cached.provider!==CH_PROVIDER||cached.complete!==true||!cached.fullFetchedAt||(now-cached.fullFetchedAt)>=CH_REMOTE_FULL_REFRESH_MS;
            if(forceFull||needsPeriodicFull){
                callbacks.onProgress?.({stage:'full',message:'完整刷新云端对话…'});
                const progressiveCallbacks={...callbacks,onPartial:partial=>{
                    callbacks.onPartial?.(partial);
                    if(!cached?.complete && partial?.list?.length){
                        void chRemoteCachePut(workspaceId,{...partial,complete:false,fullFetchedAt:Number(cached?.fullFetchedAt||0),validatedAt:Number(cached?.validatedAt||0),headFingerprint:cached?.headFingerprint||null,note:partial.note||'progressive incomplete remote index'});
                    }
                }};
                const full=await chFetchFullRemoteUniverse(workspaceId,progressiveCallbacks);
                let head={validatedAt:Date.now(),fingerprint:null};
                try{head=await chFetchRemoteHeadSnapshot(workspaceId,callbacks);}catch(err){console.warn('[ChatHarbor] head fingerprint refresh failed after full snapshot',err);}
                const snapshot={list:full.list,complete:full.complete,note:full.note,fullFetchedAt:now,validatedAt:head.validatedAt||Date.now(),headFingerprint:head.fingerprint||null};
                // Incomplete snapshots are still useful UI/discovery cache, but never prove LOCAL_ONLY.
                await chRemoteCachePut(workspaceId,snapshot);
                return {...snapshot,refreshMode:full.complete?'full':'full-incomplete'};
            }
            callbacks.onProgress?.({stage:'fast',message:`快速核对最新 ${CH_REMOTE_HEAD_LIMIT} 条…`});
            const head=await chFetchRemoteHeadSnapshot(workspaceId,callbacks);
            if(head.fingerprint===cached.headFingerprint){
                const snapshot={...cached,validatedAt:head.validatedAt,note:`fast refresh stable · head ${CH_REMOTE_HEAD_LIMIT}`};
                await chRemoteCachePut(workspaceId,snapshot); return {...snapshot,refreshMode:'fast-stable'};
            }
            callbacks.onProgress?.({stage:'full-after-change',message:'发现远端索引变化，转完整刷新…'});
            const full=await chFetchFullRemoteUniverse(workspaceId,callbacks); const refreshedHead=await chFetchRemoteHeadSnapshot(workspaceId,callbacks);
            const snapshot={list:full.list,complete:full.complete,note:full.note,fullFetchedAt:Date.now(),validatedAt:refreshedHead.validatedAt,headFingerprint:refreshedHead.fingerprint};
            await chRemoteCachePut(workspaceId,snapshot);
            return {...snapshot,refreshMode:full.complete?'full-after-change':'full-after-change-incomplete'};
        })().finally(()=>chRemoteRefreshFlights.delete(flightKey));
        chRemoteRefreshFlights.set(flightKey,promise); return promise;
    }

    function chTargetRelativePrefix(entry) {
        if (!entry?.projectTitle) return `${CH_LAYOUT_CONVERSATIONS_DIR}/`;
        const projectDirName = sanitizeFilename(entry.projectTitle) || 'Untitled Project';
        return `${CH_LAYOUT_PROJECTS_DIR}/${projectDirName}/`;
    }

    function chTargetRelativePrefixForRecord(record) {
        return chTargetRelativePrefix({ projectTitle: record?.project_title || null });
    }

    function chSplitPath(path) {
        return String(path || '').split('/').filter(Boolean);
    }

    function chPathBasename(path) {
        const parts = chSplitPath(path);
        return parts.length ? parts[parts.length - 1] : '';
    }

    function chPathDirname(path) {
        const parts = chSplitPath(path);
        parts.pop();
        return parts.join('/');
    }

    async function chEnsureRelativeDirectory(rootHandle, relativeDir = '') {
        let dir = rootHandle;
        for (const segment of chSplitPath(relativeDir)) {
            dir = await dir.getDirectoryHandle(segment, { create: true });
        }
        return dir;
    }

    async function chGetFileAtRelativePath(rootHandle, relativePath) {
        const parts = chSplitPath(relativePath);
        if (!parts.length) throw new Error('file path missing');
        let dir = rootHandle;
        for (let i = 0; i < parts.length - 1; i++) dir = await dir.getDirectoryHandle(parts[i]);
        const handle = await dir.getFileHandle(parts[parts.length - 1]);
        return { handle, file: await handle.getFile() };
    }

    async function chRelativeFileExists(rootHandle, relativePath) {
        if (!relativePath) return false;
        try { await chGetFileAtRelativePath(rootHandle, relativePath); return true; }
        catch (err) { if (err?.name === 'NotFoundError') return false; throw err; }
    }

    async function chSha256Bytes(data) {
        const buffer = data instanceof ArrayBuffer
            ? data
            : ArrayBuffer.isView(data)
                ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
                : await data.arrayBuffer();
        return chHex(await crypto.subtle.digest('SHA-256', buffer));
    }

    async function chCopyRelativeFileVerified(rootHandle, sourcePath, targetPath) {
        if (!sourcePath || !targetPath) throw new Error('migration source/target path missing');
        if (sourcePath === targetPath) {
            if (!await chRelativeFileExists(rootHandle, sourcePath)) throw new Error(`migration source missing: ${sourcePath}`);
            return { copied: false, reused: true, bytes: (await chGetFileAtRelativePath(rootHandle, sourcePath)).file.size };
        }
        const source = await chGetFileAtRelativePath(rootHandle, sourcePath);
        const sourceBytes = await source.file.arrayBuffer();
        const sourceHash = await chSha256Bytes(sourceBytes);
        const targetParts = chSplitPath(targetPath);
        const targetName = targetParts.pop();
        const targetDir = await chEnsureRelativeDirectory(rootHandle, targetParts.join('/'));
        let targetExists = false;
        try {
            const existingHandle = await targetDir.getFileHandle(targetName);
            const existingFile = await existingHandle.getFile();
            targetExists = true;
            if (existingFile.size === source.file.size && await chSha256Bytes(existingFile) === sourceHash) {
                return { copied: false, reused: true, bytes: existingFile.size };
            }
            throw new Error(`migration target collision: ${targetPath}`);
        } catch (err) {
            if (targetExists || err?.name !== 'NotFoundError') throw err;
        }
        await chVerifiedDirectoryWrite(targetDir, targetName, sourceBytes);
        const written = await targetDir.getFileHandle(targetName);
        const writtenFile = await written.getFile();
        if (writtenFile.size !== source.file.size || await chSha256Bytes(writtenFile) !== sourceHash) {
            throw new Error(`migration verification failed: ${targetPath}`);
        }
        return { copied: true, reused: false, bytes: writtenFile.size };
    }

    function chMigrationExpectedRecord(record) {
        const prefix = chTargetRelativePrefixForRecord(record);
        const jsonName = chPathBasename(record?.json_path || '');
        const markdownName = chPathBasename(record?.markdown_path || '');
        if (!jsonName || !markdownName) throw new Error(`tracked conversation ${record?.conversation_id || ''} is missing JSON/Markdown path`);
        const oldAssets = Array.isArray(record?.assets) ? record.assets : [];
        const oldAssetDir = record?.asset_dir || (oldAssets.length ? chPathDirname(oldAssets[0]?.path || '') : null);
        const assetFolderName = oldAssetDir ? chPathBasename(oldAssetDir) : null;
        const newAssetDir = assetFolderName ? `${prefix}${assetFolderName}` : null;
        const assets = oldAssets.map(asset => {
            const name = chPathBasename(asset?.path || '') || asset?.name;
            if (!name || !newAssetDir) throw new Error(`tracked asset path is incomplete for ${record?.conversation_id || ''}`);
            return {
                ...asset,
                path: `${newAssetDir}/${name}`,
                markdown_path: encodeRelativePath(`${assetFolderName}/${name}`)
            };
        });
        return {
            ...record,
            json_path: `${prefix}${jsonName}`,
            markdown_path: `${prefix}${markdownName}`,
            asset_dir: newAssetDir,
            assets
        };
    }

    function chMigrationPreviousPaths(record) {
        return {
            json_path: record?.json_path || null,
            markdown_path: record?.markdown_path || null,
            asset_dir: record?.asset_dir || null,
            assets: (record?.assets || []).map(asset => ({ path: asset?.path || null })).filter(asset => asset.path)
        };
    }

    function chMigrationOldRecordFromMarker(currentRecord) {
        const previous = currentRecord?.migration_previous_paths;
        if (!previous) return null;
        return {
            json_path: previous.json_path || null,
            markdown_path: previous.markdown_path || null,
            asset_dir: previous.asset_dir || null,
            assets: Array.isArray(previous.assets) ? previous.assets : []
        };
    }

    async function chArchiveLayoutState(rootHandle) {
        const result = await chReadManifestForScan(rootHandle);
        if (result.error) throw new Error(result.error);
        if (!result.exists || !result.manifest) {
            return {
                manifestExists: false,
                provider: CH_PROVIDER,
                layoutVersion: CH_ARCHIVE_LAYOUT_VERSION,
                requiresMigration: false,
                migrationInProgress: false,
                total: 0,
                project: 0,
                root: 0
            };
        }
        const manifest = result.manifest;
        const records = Object.values(manifest.conversations || {});
        return {
            manifestExists: true,
            provider: chManifestProvider(manifest) || CH_PROVIDER,
            layoutVersion: chManifestLayoutVersion(manifest),
            requiresMigration: chManifestRequiresLayoutMigration(manifest),
            migrationInProgress: Boolean(manifest.migration_state?.type === 'archive_layout'),
            total: records.length,
            project: records.filter(record => record?.project_id || record?.project_title).length,
            root: records.filter(record => !(record?.project_id || record?.project_title)).length,
            manifest
        };
    }

    async function chMigrateArchiveLayoutV1ToV2(rootHandle, onProgress = null) {
        if (!rootHandle) throw new Error('Directory handle is required');
        const manifest = await chReadManifest(rootHandle);
        const layout = chManifestLayoutVersion(manifest);
        if (layout > CH_ARCHIVE_LAYOUT_VERSION) throw new Error(`unsupported archive layout: ${layout}`);
        if (layout === CH_ARCHIVE_LAYOUT_VERSION && !manifest.migration_state) {
            return { migrated: 0, alreadyCurrent: true, cleanupWarnings: [], total: Object.keys(manifest.conversations || {}).length };
        }

        const entries = Object.entries(manifest.conversations || {});
        const cleanupWarnings = [];
        const legacyTopDirs = new Set();
        let migrated = 0;

        // Full local-only preflight: every tracked JSON/Markdown must exist before any new
        // conversation is committed. This migration never fetches remote conversation detail.
        for (const [id, record] of entries) {
            const previous = record?.migration_previous_paths || chMigrationPreviousPaths(record);
            for (const requiredPath of [previous.json_path, previous.markdown_path]) {
                if (requiredPath && !await chRelativeFileExists(rootHandle, requiredPath) && !await chRelativeFileExists(rootHandle, chMigrationExpectedRecord(record)[requiredPath === previous.json_path ? 'json_path' : 'markdown_path'])) {
                    throw new Error(`migration source missing for ${id}: ${requiredPath}`);
                }
            }
            const first = chSplitPath(previous.json_path || '')[0];
            if (record?.project_title && first && ![CH_LAYOUT_PROJECTS_DIR, CH_LAYOUT_CONVERSATIONS_DIR].includes(first)) legacyTopDirs.add(first);
        }

        manifest.provider = CH_PROVIDER;
        manifest.source = CH_PROVIDER_LABEL;
        manifest.migration_state = manifest.migration_state || {
            type: 'archive_layout',
            from: layout,
            to: CH_ARCHIVE_LAYOUT_VERSION,
            status: 'in_progress',
            started_at: new Date().toISOString()
        };
        await chWriteManifest(rootHandle, manifest);

        for (let index = 0; index < entries.length; index++) {
            const [id] = entries[index];
            let record = manifest.conversations[id];
            if (!record) continue;
            if (onProgress) onProgress({ index, total: entries.length, id, title: record.title || id, phase: 'prepare' });

            // Resume-safe cleanup if a prior run committed the v2 paths but was interrupted before cleanup.
            if (record.migration_previous_paths) {
                const oldRecord = chMigrationOldRecordFromMarker(record);
                const cleanup = await chCleanupTrackedOldPaths({ rootHandle, oldRecord, newRecord: record, manifest, currentId: id });
                cleanupWarnings.push(...(cleanup.warnings || []).map(w => `${id}: ${w}`));
                delete record.migration_previous_paths;
                manifest.conversations[id] = record;
                await chWriteManifest(rootHandle, manifest);
                migrated++;
                if (onProgress) onProgress({ index: index + 1, total: entries.length, id, title: record.title || id, phase: 'resumed' });
                continue;
            }

            const oldRecord = JSON.parse(JSON.stringify(record));
            const expected = chMigrationExpectedRecord(record);
            const copies = [
                [record.json_path, expected.json_path],
                [record.markdown_path, expected.markdown_path]
            ];
            const oldAssets = Array.isArray(record.assets) ? record.assets : [];
            for (let i = 0; i < oldAssets.length; i++) copies.push([oldAssets[i]?.path, expected.assets[i]?.path]);

            for (const [sourcePath, targetPath] of copies) {
                if (!sourcePath || !targetPath) continue;
                await chCopyRelativeFileVerified(rootHandle, sourcePath, targetPath);
            }

            const committed = {
                ...expected,
                migration_previous_paths: chMigrationPreviousPaths(oldRecord)
            };
            manifest.conversations[id] = committed;
            await chWriteManifest(rootHandle, manifest);

            const cleanup = await chCleanupTrackedOldPaths({ rootHandle, oldRecord, newRecord: committed, manifest, currentId: id });
            cleanupWarnings.push(...(cleanup.warnings || []).map(w => `${id}: ${w}`));
            delete committed.migration_previous_paths;
            manifest.conversations[id] = committed;
            await chWriteManifest(rootHandle, manifest);
            migrated++;
            if (onProgress) onProgress({ index: index + 1, total: entries.length, id, title: committed.title || id, phase: 'committed' });
        }

        // Verify every canonical v2 JSON/Markdown before declaring the archive upgraded.
        for (const [id, record] of Object.entries(manifest.conversations || {})) {
            const expected = chMigrationExpectedRecord(record);
            if (record.json_path !== expected.json_path || record.markdown_path !== expected.markdown_path) {
                throw new Error(`layout verification failed for ${id}`);
            }
            if (!await chRelativeFileExists(rootHandle, record.json_path) || !await chRelativeFileExists(rootHandle, record.markdown_path)) {
                throw new Error(`migrated files missing for ${id}`);
            }
        }

        manifest.provider = CH_PROVIDER;
        manifest.source = CH_PROVIDER_LABEL;
        manifest.archive_layout_version = CH_ARCHIVE_LAYOUT_VERSION;
        delete manifest.migration_state;
        await chWriteManifest(rootHandle, manifest);

        // Best-effort removal of now-empty legacy project containers only. Anything untracked
        // prevents removal and is deliberately preserved.
        for (const name of legacyTopDirs) {
            try { await rootHandle.removeEntry(name, { recursive: false }); }
            catch (err) { if (err?.name !== 'NotFoundError') cleanupWarnings.push(`legacy directory preserved: ${name}`); }
        }

        return {
            migrated,
            alreadyCurrent: false,
            total: entries.length,
            cleanupWarnings,
            provider: CH_PROVIDER,
            archiveLayoutVersion: CH_ARCHIVE_LAYOUT_VERSION
        };
    }

    function chEncodeRelativeSegments(segments) {
        return segments.map(segment => segment === '..' ? '..' : encodeURIComponent(segment)).join('/');
    }

    function chRelativeMarkdownPath(fromPrefix, targetRootRelativePath) {
        const from = chSplitPath(fromPrefix);
        const to = chSplitPath(targetRootRelativePath);
        let common = 0;
        while (common < from.length && common < to.length && from[common] === to[common]) common++;
        const parts = [
            ...Array(Math.max(0, from.length - common)).fill('..'),
            ...to.slice(common)
        ];
        return chEncodeRelativeSegments(parts);
    }

    function chExistingAttachmentResultForPrefix(existingRecord, targetPrefix) {
        const base = chExistingAttachmentResult(existingRecord);
        if (!base) return null;
        const assets = Array.isArray(existingRecord?.assets) ? existingRecord.assets : [];
        const sandboxPaths = new Map();
        let sandboxSourceComplete = true;
        const files = assets.map(asset => {
            const relativeLink = chRelativeMarkdownPath(targetPrefix, asset.path || '');
            if (asset?.kind === 'sandbox') {
                if (asset.message_id && asset.source_sandbox_path) {
                    sandboxPaths.set(`${asset.message_id}|${asset.source_sandbox_path}`, relativeLink);
                } else {
                    sandboxSourceComplete = false;
                }
            }
            return {
                name: asset.name,
                path: relativeLink,
                disk_path: asset.path,
                kind: asset.kind,
                isImage: Boolean(asset.is_image),
                messageId: asset.message_id || null,
                ownerRole: asset.owner_role || null,
                sourceCategory: asset.source_category || chAttachmentStoredSourceCategory(asset),
                referenceKind: asset.reference_kind || asset.kind || null,
                size_bytes: asset.size_bytes || 0,
                source_file_id: asset.source_file_id || null,
                source_sandbox_path: asset.source_sandbox_path || null
            };
        });
        return {
            ...base,
            files,
            sandboxPaths,
            sandboxSourceComplete
        };
    }

    function chFinalMetadataDiffs(remote, local) {
        const reasons=[];
        const archiveKnown=(remote?.__chArchiveState||'known')!=='unknown';
        const projectKnown=(remote?.__chProjectState||'known')!=='unknown';
        if(archiveKnown&&Object.prototype.hasOwnProperty.call(remote||{},'is_archived')&&Boolean(remote?.is_archived)!==Boolean(chRecordListArchiveState(local)))reasons.push('ARCHIVE_STATE_DIFF');
        if(projectKnown&&String(remote?.projectId??'')!==String(chRecordListProjectId(local)??''))reasons.push('PROJECT_ID_DIFF');
        if(projectKnown&&String(remote?.projectTitle??'')!==String(chRecordListProjectTitle(local)??''))reasons.push('PROJECT_TITLE_DIFF');
        return reasons;
    }

    async function chClassifyFetchedConversation(preflightItem, convData, options = {}) {
        const includeAttachments=Boolean(options.includeAttachments);
        const retryFailedAttachments=Boolean(options.retryFailedAttachments);
        const remote=preflightItem?.remote||{}; const local=preflightItem?.local||null;
        const id=chGetConversationId(remote,convData); const detailTitle=String(convData?.title||remote?.title||'');
        const remoteUpdateTime=convData?.update_time??remote?.update_time??null; const newSignature=await chContentSignature(convData);
        const attachmentInspection=chInspectAttachmentCompleteness(convData,local);
        if(!local)return {...preflightItem,id,finalAction:'NEW',convData,newSignature,contentChanged:true,titleChanged:false,metadataChanged:false,timestampChanged:false,attachmentInspection,needs_sync:true,finalReasons:['NOT_IN_LOCAL_ARCHIVE']};
        if(local.tracking!=='manifest')return {...preflightItem,id,finalAction:'LOCAL_UNTRACKED',convData,newSignature,contentChanged:null,titleChanged:detailTitle!==String(local?.title||''),metadataChanged:false,timestampChanged:chTimeRelation(remoteUpdateTime,local?.remote_update_time)!=='same',attachmentInspection,needs_sync:true,finalReasons:['LOCAL_RAW_NOT_MANIFEST_TRACKED','NO_AUTHORITATIVE_LOCAL_SIGNATURE']};
        const oldSignature=String(local?.content_signature||'');
        if(!oldSignature)return {...preflightItem,id,finalAction:'ERROR',convData,newSignature,contentChanged:null,titleChanged:detailTitle!==String(local?.title||''),metadataChanged:null,timestampChanged:null,attachmentInspection,needs_sync:false,finalReasons:['LOCAL_SIGNATURE_MISSING'],error:'Tracked manifest record has no content_signature'};

        const contentChanged=newSignature!==oldSignature;
        const titleChanged=detailTitle!==String(local?.title||'');
        const metadataReasons=chFinalMetadataDiffs(remote,local); const metadataChanged=metadataReasons.length>0;
        const timestampChanged=chTimeRelation(remoteUpdateTime,local?.remote_update_time)==='different';
        const attachmentBackfill=includeAttachments&&chAttachmentNeedsAction(local,retryFailedAttachments);
        let finalAction='OBSERVATION_ONLY';
        if(contentChanged&&titleChanged)finalAction='UPDATED_AND_RENAMED';
        else if(contentChanged)finalAction='UPDATED';
        else if(titleChanged)finalAction='RENAMED_ONLY';
        else if(attachmentBackfill)finalAction='ATTACHMENT_BACKFILL';
        else if(metadataChanged)finalAction='METADATA_ONLY';
        return {...preflightItem,id,finalAction,convData,newSignature,contentChanged,titleChanged,metadataChanged,timestampChanged,attachmentInspection,attachmentBackfill,needs_sync:true,finalReasons:[...(contentChanged?['CONTENT_SIGNATURE_DIFF']:[]),...(titleChanged?['TITLE_DIFF']:[]),...metadataReasons,...(timestampChanged?['DETAIL_UPDATE_TIME_DIFF']:[]),...(attachmentBackfill?[`ATTACHMENT_${attachmentInspection.state.toUpperCase()}`]:[]),...(finalAction==='OBSERVATION_ONLY'?['REMOTE_OBSERVATION_ADVANCE']:[])]};
    }

    async function chVerifyPreflightCandidates({ plan, workspaceId = null }) {
        const resultItems = [];
        const fetchItems = plan.items.filter(item => item.needs_detail_fetch && item.action !== 'ERROR' && item.action !== 'DUPLICATE');
        const fetchTotal = fetchItems.length;

        if (fetchTotal > 0 && !await ensureAccessToken()) {
            throw new Error('当前登录信息不可用。请刷新 ChatGPT 页面后再试。');
        }

        let fetchIndex = 0;
        for (const item of plan.items) {
            if (!item.needs_detail_fetch || item.action === 'ERROR' || item.action === 'DUPLICATE') {
                resultItems.push({
                    ...item,
                    finalAction: item.action,
                    needs_sync: false,
                    finalReasons: item.reasons || []
                });
                continue;
            }

            const title = item.remote?.title || item.local?.title || item.id;
            chSetProgress(
                '核验远端详情',
                `${fetchIndex + 1}/${fetchTotal} · ${String(title).slice(0, 60)}`,
                fetchTotal ? Math.round((fetchIndex / fetchTotal) * 45) : 45
            );
            try {
                await chControlCheckpoint('detail-verification');
                const convData = await chGetConversationConservative(item.id, workspaceId, title);
                resultItems.push(await chClassifyFetchedConversation(item, convData, { includeAttachments: false }));
            } catch (err) {
                if (chIsCancellation(err)) throw err;
                resultItems.push({
                    ...item,
                    finalAction: 'ERROR',
                    needs_sync: false,
                    finalReasons: ['DETAIL_FETCH_OR_CLASSIFICATION_FAILED'],
                    error: err?.message || String(err)
                });
            }
            fetchIndex++;
        }

        const counts = {};
        for (const item of resultItems) counts[item.finalAction] = (counts[item.finalAction] || 0) + 1;
        return {
            items: resultItems,
            counts,
            detailFetchCount: fetchTotal
        };
    }

    function chExpectedStoragePaths(entry, convData) {
        const prefix = chTargetRelativePrefix(entry);
        return {
            prefix,
            json_path: `${prefix}${generateUniqueFilename(convData)}`,
            markdown_path: `${prefix}${generateMarkdownFilename(convData)}`
        };
    }

    function chMetadataOnlyRecord(existingRecord, classifiedItem) {
        const remote=classifiedItem.remote||{}; const convData=classifiedItem.convData||{};
        const observed=chRemoteObservation(remote,existingRecord);
        const inspection=classifiedItem.attachmentInspection||null;
        const projectKnown=(remote?.__chProjectState||'known')!=='unknown';
        const archiveKnown=(remote?.__chArchiveState||'known')!=='unknown';
        return {
            ...existingRecord,
            title: convData.title || existingRecord.title,
            create_time: convData.create_time ?? remote.create_time ?? existingRecord.create_time ?? null,
            remote_update_time: convData.update_time ?? existingRecord.remote_update_time ?? null,
            is_archived: archiveKnown ? Boolean(remote?.is_archived) : (existingRecord.is_archived ?? false),
            project_id: projectKnown ? (remote?.projectId ?? null) : (existingRecord.project_id ?? null),
            project_title: projectKnown ? (remote?.projectTitle ?? null) : (existingRecord.project_title ?? null),
            ...observed,
            provider:CH_PROVIDER,archive_layout_version:CH_ARCHIVE_LAYOUT_VERSION,
            content_signature:classifiedItem.newSignature||existingRecord.content_signature,signature_version:CH_SIGNATURE_VERSION,
            attachment_state:inspection?.state||chRecordAttachmentState(existingRecord),
            attachments_checked_at:inspection?new Date().toISOString():(existingRecord.attachments_checked_at||null),
            attachment_detected:inspection?.detected??existingRecord.attachment_detected,
            // synced_at intentionally remains the last content/file commit time.
            synced_at: existingRecord.synced_at || null
        };
    }

    function chManifestPathReferencedElsewhere(manifest, currentId, path) {
        if (!path) return false;
        for (const [id, record] of Object.entries(manifest?.conversations || {})) {
            if (id === currentId) continue;
            if (record?.json_path === path || record?.markdown_path === path || record?.asset_dir === path) return true;
            if ((record?.assets || []).some(asset => asset?.path === path)) return true;
        }
        return false;
    }

    async function chRemoveTrackedEntry(rootHandle, relativePath, isDirectory = false) {
        if (!relativePath) return { removed: false, reason: 'EMPTY_PATH' };
        const parts = chSplitPath(relativePath);
        if (parts.length === 0) return { removed: false, reason: 'EMPTY_PATH' };
        try {
            let dir = rootHandle;
            for (let i = 0; i < parts.length - 1; i++) {
                dir = await dir.getDirectoryHandle(parts[i]);
            }
            if (isDirectory) await dir.removeEntry(parts[parts.length - 1], { recursive: false });
            else await dir.removeEntry(parts[parts.length - 1]);
            return { removed: true, reason: null };
        } catch (err) {
            if (err?.name === 'NotFoundError') return { removed: false, reason: 'ALREADY_MISSING' };
            return { removed: false, reason: err?.message || String(err) };
        }
    }

    async function chCleanupTrackedOldPaths({ rootHandle, oldRecord, newRecord, manifest, currentId }) {
        if (!oldRecord) return { removed: [], warnings: [] };
        const removed = [];
        const warnings = [];
        const newAssetPaths = new Set((newRecord?.assets || []).map(asset => asset?.path).filter(Boolean));
        const candidates = [];

        if (oldRecord.json_path && oldRecord.json_path !== newRecord.json_path) {
            candidates.push({ path: oldRecord.json_path, kind: 'json' });
        }
        if (oldRecord.markdown_path && oldRecord.markdown_path !== newRecord.markdown_path) {
            candidates.push({ path: oldRecord.markdown_path, kind: 'markdown' });
        }
        for (const asset of oldRecord.assets || []) {
            if (asset?.path && !newAssetPaths.has(asset.path)) {
                candidates.push({ path: asset.path, kind: 'asset' });
            }
        }

        for (const candidate of candidates) {
            if (chManifestPathReferencedElsewhere(manifest, currentId, candidate.path)) {
                warnings.push(`${candidate.kind}: shared path preserved: ${candidate.path}`);
                continue;
            }
            const outcome = await chRemoveTrackedEntry(rootHandle, candidate.path, false);
            if (outcome.removed) removed.push(candidate.path);
            else if (outcome.reason !== 'ALREADY_MISSING') warnings.push(`${candidate.kind}: ${candidate.path}: ${outcome.reason}`);
        }

        if (oldRecord.asset_dir && oldRecord.asset_dir !== newRecord.asset_dir &&
            !chManifestPathReferencedElsewhere(manifest, currentId, oldRecord.asset_dir)) {
            // Non-recursive on purpose. If any untracked legacy asset remains, the directory stays.
            const outcome = await chRemoveTrackedEntry(rootHandle, oldRecord.asset_dir, true);
            if (outcome.removed) removed.push(oldRecord.asset_dir);
            else if (!['ALREADY_MISSING', 'Directory not empty'].includes(outcome.reason)) {
                // Browser error text is implementation-specific; any failure is safe because cleanup is best-effort.
                warnings.push(`asset_dir preserved: ${oldRecord.asset_dir}: ${outcome.reason}`);
            }
        }

        return { removed, warnings };
    }

    async function chApplyClassifiedSyncItem({
        rootHandle,
        classifiedItem,
        manifest,
        workspaceId = null,
        includeAttachments = false,
        retryFailedAttachments = false,
        btn = null,
        conversationIndex = 0,
        conversationTotal = 1,
        deps = {}
    }) {
        const action = classifiedItem.finalAction;
        if (!CH_FINAL_SYNC_ACTIONS.has(action)) {
            return { status: 'SKIPPED', action, id: classifiedItem.id, reason: 'NOT_ACTIONABLE' };
        }

        const id = classifiedItem.id;
        const remote = classifiedItem.remote || {};
        const convData = classifiedItem.convData;
        if (!convData) throw new Error(`Missing fetched conversation detail for ${id}`);

        const writeConversation = deps.writeConversation || chWriteConversationToDirectory;
        const writeManifest = deps.writeManifest || chWriteManifest;
        const cleanup = deps.cleanup || chCleanupTrackedOldPaths;
        const oldRecord = manifest.conversations?.[id] || null;
        const expected = chExpectedStoragePaths(remote, convData);

        const metadataOnlyInPlace = ['METADATA_ONLY','OBSERVATION_ONLY'].includes(action) && oldRecord &&
            oldRecord.json_path === expected.json_path &&
            oldRecord.markdown_path === expected.markdown_path;

        if (metadataOnlyInPlace) {
            const updatedRecord = chMetadataOnlyRecord(oldRecord, classifiedItem);
            manifest.conversations[id] = updatedRecord;
            await writeManifest(rootHandle, manifest);
            return {
                status: 'SYNCED',
                mode: 'MANIFEST_ONLY',
                action,
                id,
                record: updatedRecord,
                cleanup: { removed: [], warnings: [] }
            };
        }

        const existingRecord = oldRecord || null;
        const existingAttachmentResultOverride = !includeAttachments && existingRecord
            ? chExistingAttachmentResultForPrefix(existingRecord, expected.prefix)
            : null;

        const record = await writeConversation({
            rootHandle,
            entry: remote,
            convData,
            workspaceId,
            includeAttachments,
            retryFailedAttachments,
            existingRecord,
            existingAttachmentResultOverride,
            btn: btn || getExportButton(),
            conversationIndex,
            conversationTotal
        });

        const attachmentReport = record.__ch_attachment_report || null;
        const newAssetPaths = Array.isArray(record.__ch_new_asset_paths) ? [...record.__ch_new_asset_paths] : [];
        delete record.__ch_attachment_report;
        delete record.__ch_new_asset_paths;
        const priorManifestRecord = manifest.conversations?.[record.conversation_id] || null;
        manifest.conversations[record.conversation_id] = record;
        try {
            await writeManifest(rootHandle, manifest);
        } catch (err) {
            if (priorManifestRecord) manifest.conversations[record.conversation_id] = priorManifestRecord;
            else delete manifest.conversations[record.conversation_id];
            for (const path of newAssetPaths) {
                try { await chRemoveTrackedEntry(rootHandle, path, false); } catch (_) {}
            }
            throw err;
        }

        const cleanupResult = oldRecord
            ? await cleanup({
                rootHandle,
                oldRecord,
                newRecord: record,
                manifest,
                currentId: record.conversation_id
            })
            : { removed: [], warnings: [] };

        return {
            status: 'SYNCED',
            mode: 'FILES_AND_MANIFEST',
            action,
            id: record.conversation_id,
            record,
            attachmentReport,
            cleanup: cleanupResult
        };
    }

    function chIntegratedSyncReportText(result) {
        const c = result.verification.counts || {};
        const ctx = result.reportContext || {};
        const policy = chAttachmentPolicyReport(Boolean(ctx.includeAttachments), Boolean(ctx.retryFailedAttachments));
        const attachments = chAttachmentRunSummary(result);
        const local = result.postSyncLocalSummary || result.plan.summary || {};
        const lines = [
            `${chT('ChatHarbor','ChatHarbor')} v${CH_PRODUCT_VERSION}｜${chT('版本感知选择性同步','Version-aware Selective Sync')}`, '',
            `【${chT('报告信息','Report information')}】`,
            `${chT('报告类型','Report type')}: SYNC_COMPLETION`,
            `${chT('运行开始','Run started')}: ${chFormatLocalTimestamp(ctx.run_started_at)}`,
            `${chT('运行结束','Run finished')}: ${chFormatLocalTimestamp(ctx.run_finished_at)}`,
            `${chT('报告生成','Report generated')}: ${chFormatLocalTimestamp()}`,
            `${chT('报告阶段','Report stage')}: ${chT('同步事务结束后','After sync transaction completion')}`,
            `${chT('状态来源','State source')}: ${result.postSyncLocalSummary ? 'post-sync local reconciliation' : 'sync transaction result (post-sync local reconciliation pending)'}`,
            `${chT('手动重新检查','Manual local recheck')}: ${chT('否','NO')}`, '',
            `【${chT('附件策略','Attachment policy')}】`,
            `includeAttachments: ${Boolean(ctx.includeAttachments)}`,
            `retryFailedAttachments: ${Boolean(ctx.retryFailedAttachments)}`,
            `policy: ${policy.policy}`,
            `${chT('说明','Description')}: ${policy.description}`, '',
            `【${chT('同步结果','Sync result')}】`,
            `${chT('范围内远端ID','Scope remote IDs')}: ${result.plan.summary.scopeRemote}`,
            `${chT('实际抓取详情','Detail fetched')}: ${result.verification.detailFetchCount}`,
            `${chT('新增','NEW')}: ${c.NEW||0}`, `${chT('内容更新','UPDATED')}: ${c.UPDATED||0}`, `${chT('仅改名','RENAMED_ONLY')}: ${c.RENAMED_ONLY||0}`,
            `${chT('更新+改名','UPDATED_AND_RENAMED')}: ${c.UPDATED_AND_RENAMED||0}`, `${chT('仅元数据','METADATA_ONLY')}: ${c.METADATA_ONLY||0}`,
            `${chT('已同步','UNCHANGED')}: ${(c.UNCHANGED||0)+(c.OBSERVATION_ONLY||0)}`, `${chT('附件补齐','Attachment backfill')}: ${c.ATTACHMENT_BACKFILL||0}`,
            `${chT('本地未跟踪','LOCAL_UNTRACKED')}: ${c.LOCAL_UNTRACKED||0}`, `${chT('仅本地','LOCAL_ONLY')}: ${result.plan.summary.localOnlyReliable?result.plan.summary.localOnlyCount:chT('未知','UNKNOWN')}`,
            `${chT('重复ID','DUPLICATE')}: ${c.DUPLICATE||0}`, `${chT('错误','ERROR')}: ${c.ERROR||0}`, '',
            `【${chT('本轮附件结果','Attachment result this run')}】`,
            `${chT('当前处理会话中的附件引用总数','Attachment references in conversations processed this run')}: ${attachments.detected}`,
            `${chT('实际尝试下载','Download attempts')}: ${attachments.attempted}`,
            `${chT('下载成功','Downloads succeeded')}: ${attachments.downloaded}`,
            `${chT('本轮下载失败','Downloads failed this run')}: ${attachments.failed}`,
            `${chT('其中首次失败','First-time failures')}: ${attachments.firstFailures}`,
            `${chT('其中历史失败重试仍失败','Known failures retried and failed again')}: ${attachments.retriedFailures}`, '',
            `【${chT('本轮附件失败原因','Attachment failure reasons this run')}】`
        ];
        const reasonLines = chAttachmentFailureReasonLines(attachments.failures);
        if (reasonLines.length) lines.push(...reasonLines); else lines.push(chT('无','None'));
        lines.push('', `【${chT('本轮附件失败明细','Attachment failure details this run')}】`);
        if (!attachments.failures.length) lines.push(chT('无','None'));
        attachments.failures.forEach((failure,index)=>{
            lines.push(`[${index+1}]`);
            lines.push(`${chT('对话','Conversation')}: ${failure.title || '-'}`);
            lines.push(`conversation_id: ${failure.conversation_id || '-'}`);
            lines.push(`${chT('附件','Attachment')}: ${failure.name || '-'}`);
            lines.push(`${chT('来源','Source')}: ${chAttachmentSourceLabel(failure.source_category || chAttachmentSourceCategory(failure.owner_role, failure.reference_kind || failure.kind))}`);
            lines.push(`${chT('类型','Kind')}: ${failure.reference_kind || failure.kind || '-'}`);
            lines.push(`${chT('附件标识','Attachment identity')}: ${failure.file_id || failure.sandbox_path || '-'}`);
            lines.push(`${chT('失败阶段','Failure stage')}: ${chAttachmentFailureStage(failure.error)}`);
            lines.push(`${chT('失败原因','Failure reason')}: ${failure.error || '-'}`);
            lines.push(`${chT('尝试时间','Attempt time')}: ${chFormatLocalTimestamp(failure.attempted_at)}`);
            if (failure.was_known_failure) lines.push(`${chT('历史失败重试','Historical failure retry')}: ${chT('是','YES')}`);
            lines.push('');
        });
        lines.push(`【${chT('当前本地附件状态','Current local attachment state')}】`);
        lines.push(`${chT('完整会话','Complete conversations')}: ${local.attachmentStates?.complete||0}`);
        lines.push(`${chT('不完整会话','Partial conversations')}: ${local.attachmentStates?.partial||0}`);
        lines.push(`${chT('已知失败附件','Known failed attachments')}: ${local.attachmentStates?.failed||0}`);
        lines.push(`${chT('Manifest 跟踪附件路径','Manifest tracked attachment paths')}: ${local.assetFastChecked||0}`);
        lines.push(`${chT('附件缺失/异常','Attachment issues')}: ${local.assetIntegrityIssues||0}`);
        lines.push('', ...chAttachmentProvenanceReportLines(local.attachmentProvenance || result.plan.summary.attachmentProvenance));
        lines.push('', `【${chT('事务结果','Transaction result')}】`);
        lines.push(`${chT('尝试同步','Sync attempted')}: ${result.sync.attempted}`, `${chT('同步成功','Sync succeeded')}: ${result.sync.succeeded}`, `${chT('同步失败','Sync failed')}: ${result.sync.failed}`);
        lines.push(`${chT('仅Manifest提交','Manifest-only commits')}: ${result.sync.manifestOnly}`, `${chT('文件+Manifest提交','File+manifest commits')}: ${result.sync.fileCommits}`);
        lines.push(`${chT('清理警告','Cleanup warnings')}: ${result.sync.cleanupWarnings.length}`, `${chT('已取消','Cancelled')}: ${result.sync.cancelled?chT('是','YES'):chT('否','NO')}`, '');
        lines.push(chT('LOCAL_ONLY 从未自动删除。','LOCAL_ONLY was never deleted.'), chT('清理只触碰旧 Manifest 明确跟踪的路径。','Cleanup only touched paths explicitly tracked by the prior manifest.'));
        if(result.sync.failures.length){lines.push('',`=== ${chT('同步失败项','SYNC FAILURES')} ===`);for(const f of result.sync.failures.slice(0,50))lines.push(`[${f.action}] ${f.id}: ${f.error}`);}
        if(result.sync.cleanupWarnings.length){lines.push('',`=== ${chT('清理警告（安全保留残留）','CLEANUP WARNINGS (safe leftovers preserved)')} ===`);result.sync.cleanupWarnings.slice(0,50).forEach(x=>lines.push(x));}
        return lines.join('\n');
    }

    function chShowIntegratedSyncReport(result) {
        const c = result.verification.counts || {};
        const tone = result.sync.failed || (c.ERROR||0) || (c.DUPLICATE||0) ? 'warn' : 'success';
        const localOnly = result.plan.summary.localOnlyReliable ? Math.max(0, Number(result.plan.summary.localOnlyCount || 0)) : 0;
        const summaryLines = [
            `${chT('选择','Selected')} ${result.plan.summary.scopeRemote} · ${chT('实际处理','Processed')} ${result.verification.detailFetchCount}`,
            `${chT('同步成功','Synced successfully')} ${result.sync.succeeded} · ${chT('无需更新','No update needed')} ${(c.UNCHANGED||0)+(c.OBSERVATION_ONLY||0)}`,
            `${chT('需确认','Check')} ${c.LOCAL_UNTRACKED||0} · ${chT('异常','Error')} ${(c.ERROR||0)+(c.DUPLICATE||0)+result.sync.failed}`
        ];
        if (localOnly) summaryLines.push(`${chT('仅本地记录','Local-only records')} ${localOnly} · ${chT('不在本次云端选择范围','outside the remote selection scope')}`);
        chRenderInlineReport(
            result.sync.cancelled ? chT('同步已取消','Sync cancelled') : result.sync.failed ? chT('同步完成（存在失败）','Sync completed with failures') : chT('同步完成','Sync complete'),
            summaryLines,
            chIntegratedSyncReportText(result), tone
        );
    }

    async function chRunIntegratedDirectorySync({
        rootHandle,
        remoteList,
        selectedIds = null,
        workspaceId = null,
        includeAttachments = false,
        retryFailedAttachments = false,
        remoteUniverseComplete = true,
        remoteUniverseNote = null,
        networkPolicy = null,
        onItemClassified = null,
        onItemCommitted = null,
        onItemFailed = null
    }) {
        const runStartedAt = new Date().toISOString();
        const selected = selectedIds instanceof Set && selectedIds.size > 0 ? selectedIds : null;
        if (!selected && !remoteUniverseComplete) {
            throw new Error('云端对话列表还没有加载完整。为避免漏同步，本轮不会写入，请稍后刷新重试。');
        }
        const ownsRun = !chSyncRun.active;
        if (ownsRun) chBeginControlledRun(networkPolicy || chLoadNetworkPolicy());
        else if (networkPolicy) chSyncRun.policy = chSaveNetworkPolicy(networkPolicy);

        chSetProgress('同步', `检查本地文件… · ${chNetworkPolicySummary(chSyncRun.policy)}`, 0);
        await chControlCheckpoint('local-scan');
        const localScan = await chScanLocalArchiveReadOnly(rootHandle, null, { checkAssets: true });
        if (localScan.manifestExists && !localScan.manifestReadable) {
            throw new Error('本地保存记录无法读取。为避免覆盖现有文件，本轮同步已停止。');
        }
        if (localScan.manifest && chManifestRequiresLayoutMigration(localScan.manifest)) {
            throw new Error('本地保存结构需要升级。请先完成升级，再开始同步。');
        }
        chSummarizeLocalAttachmentProvenance(localScan);
        const plan = chBuildPreflightPlan(remoteList, localScan, selected, {
            remoteUniverseComplete,
            remoteUniverseNote,
            includeAttachments
            ,retryFailedAttachments
        });
        const fetchTotal = plan.items.filter(item => item.needs_detail_fetch && item.action !== 'ERROR' && item.action !== 'DUPLICATE').length;
        if (fetchTotal > 0 && !await ensureAccessToken()) {
            throw new Error('当前登录信息不可用。请刷新 ChatGPT 页面后再试。');
        }

        const manifest = await chReadManifest(rootHandle);
        const btn = getExportButton();
        const verification = { items: [], counts: {}, detailFetchCount: 0, cancelled: false };
        const sync = {
            attempted: 0,
            succeeded: 0,
            failed: 0,
            manifestOnly: 0,
            fileCommits: 0,
            cleanupWarnings: [],
            results: [],
            failures: [],
            cancelled: false
        };
        let fetchIndex = 0;
        const fastItems = plan.items.filter(item => !item.needs_detail_fetch || item.action === 'ERROR' || item.action === 'DUPLICATE');
        const workItems = plan.items.filter(item => item.needs_detail_fetch && item.action !== 'ERROR' && item.action !== 'DUPLICATE');
        for (const item of fastItems) {
            const classified = { ...item, finalAction: item.action, needs_sync: false, finalReasons: item.reasons || [] };
            verification.items.push(classified);
            verification.counts[classified.finalAction] = (verification.counts[classified.finalAction] || 0) + 1;
        }
        const totalItems = Math.max(1, workItems.length);
        chSetRuntimeProgress({ active: workItems.length > 0, processed: 0, total: workItems.length, currentTitle: '' });
        if (workItems.length) chSetProgress('正在开始', '', 0);

        for (let i = 0; i < workItems.length; i++) {
            let classified = null;
            const item = workItems[i];
            const currentTitle = item.remote?.title || item.local?.title || item.id;
            chSetRuntimeProgress({ currentTitle: String(currentTitle || '').slice(0, 58) });
            try {
                await chControlCheckpoint('stream-sync');
                if (!item.needs_detail_fetch || item.action === 'ERROR' || item.action === 'DUPLICATE') {
                    classified = {
                        ...item,
                        finalAction: item.action,
                        needs_sync: false,
                        finalReasons: item.reasons || []
                    };
                } else {
                    const title = item.remote?.title || item.local?.title || item.id;
                    chSetProgress('正在获取对话', '', null);
                    try {
                        const convData = await chGetConversationConservative(item.id, workspaceId, title);
                        verification.detailFetchCount++;
                        fetchIndex++;
                        classified = await chClassifyFetchedConversation(item, convData, { includeAttachments, retryFailedAttachments });
                    } catch (err) {
                        if (chIsCancellation(err)) throw err;
                        verification.detailFetchCount++;
                        fetchIndex++;
                        classified = {
                            ...item,
                            finalAction: 'ERROR',
                            needs_sync: false,
                            finalReasons: ['DETAIL_FETCH_OR_CLASSIFICATION_FAILED'],
                            error: err?.message || String(err)
                        };
                    }
                }

                verification.items.push(classified);
                verification.counts[classified.finalAction] = (verification.counts[classified.finalAction] || 0) + 1;
                if (typeof onItemClassified === 'function') {
                    try { onItemClassified(classified, { processed: i + 1, total: workItems.length }); } catch (_) {}
                }

                if (CH_FINAL_SYNC_ACTIONS.has(classified.finalAction)) {
                    sync.attempted++;
                    try {
                        const applied = await chApplyClassifiedSyncItem({
                            rootHandle,
                            classifiedItem: classified,
                            manifest,
                        workspaceId,
                        includeAttachments,
                        retryFailedAttachments,
                            btn,
                            conversationIndex: i,
                            conversationTotal: totalItems
                        });
                        sync.succeeded++;
                        if (applied.mode === 'MANIFEST_ONLY') sync.manifestOnly++;
                        if (applied.mode === 'FILES_AND_MANIFEST') sync.fileCommits++;
                        sync.cleanupWarnings.push(...(applied.cleanup?.warnings || []).map(w => `${classified.id}: ${w}`));
                        sync.results.push(applied);
                        if (typeof onItemCommitted === 'function') {
                            try { onItemCommitted(classified, applied); } catch (_) {}
                        }
                    } catch (err) {
                        if (chIsCancellation(err)) throw err;
                        sync.failed++;
                        sync.failures.push({
                            id: classified.id,
                            action: classified.finalAction,
                            error: err?.message || String(err)
                        });
                        if (typeof onItemFailed === 'function') {
                            try { onItemFailed(classified, err); } catch (_) {}
                        }
                    }
                }
                chSetRuntimeProgress({ processed: i + 1, currentTitle: String(currentTitle || '').slice(0, 58) });
                chSetProgress('', '', null);

            } catch (err) {
                if (chIsCancellation(err)) {
                    verification.cancelled = true;
                    sync.cancelled = true;
                    break;
                }
                throw err;
            }
        }

        chSetRuntimeProgress({ active:false });
        chSetProgress(
            sync.cancelled ? '同步已取消' : (sync.failed ? '同步完成（有异常）' : '同步完成'),
            sync.cancelled
                ? `已安全提交 ${sync.succeeded} 个会话；未开始的会话保持不变，下次可继续。`
                : `写入成功 ${sync.succeeded} · 未变化 ${verification.counts.UNCHANGED || 0} · 异常 ${(verification.counts.ERROR || 0) + (verification.counts.DUPLICATE || 0)}`,
            100
        );

        const result = { localScan, plan, verification, sync, reportContext: { type: 'SYNC_COMPLETION', run_started_at: runStartedAt, run_finished_at: new Date().toISOString(), includeAttachments: Boolean(includeAttachments), retryFailedAttachments: Boolean(retryFailedAttachments) } };
        chShowIntegratedSyncReport(result);
        result.reportPending = true;
        result.reportSelectedIds = [...(selected || [])];
        console.log('[ChatHarbor Integrated Sync]', result);
        return result;
    }


    async function exportConversations(options = {}) {
        const {
            mode = 'personal',
            workspaceId = null,
            conversationEntries = null,
            exportType = null,
            includeAttachments = false
        } = options;
        const btn = getExportButton();
        btn.disabled = true;

        if (!await ensureAccessToken()) {
            btn.disabled = false;
            setFabStatus(btn, EXPORT_BUTTON_LABEL);
            return;
        }

        try {
            const zip = new JSZip();
            const attachmentReport = includeAttachments ? {
                chatharbor_version: ATTACHMENT_EXPORT_VERSION,
                generated_at: new Date().toISOString(),
                detected: 0,
                downloaded: 0,
                failed: 0,
                conversations: []
            } : null;
            if (Array.isArray(conversationEntries) && conversationEntries.length > 0) {
                for (let i = 0; i < conversationEntries.length; i++) {
                    const entry = conversationEntries[i];
                    const label = entry?.title ? entry.title.slice(0, 12) : '对话';
                    setFabStatus(btn, `📥 ${label} (${i + 1}/${conversationEntries.length})`);
                    const convData = await getConversation(entry.id, workspaceId);
                    const target = entry?.projectTitle
                        ? zip.folder(sanitizeFilename(entry.projectTitle))
                        : zip;
                    await addConversationToZip(target, convData, workspaceId, attachmentReport);
                    await sleep(jitter());
                }
            } else {
                setFabStatus(btn, '📂 获取项目外对话…');
                const orphanIds = await collectIds(btn, workspaceId, null);
                for (let i = 0; i < orphanIds.length; i++) {
                    setFabStatus(btn, `📥 根目录 (${i + 1}/${orphanIds.length})`);
                    const convData = await getConversation(orphanIds[i], workspaceId);
                    await addConversationToZip(zip, convData, workspaceId, attachmentReport);
                    await sleep(jitter());
                }

                setFabStatus(btn, '🔍 获取项目列表…');
                const projects = await getProjects(workspaceId);
                for (const project of projects) {
                    const projectFolder = zip.folder(sanitizeFilename(project.title));
                    setFabStatus(btn, `📂 项目: ${project.title}`);
                    const projectConvIds = await collectIds(btn, workspaceId, project.id);
                    if (projectConvIds.length === 0) continue;

                    for (let i = 0; i < projectConvIds.length; i++) {
                        setFabStatus(btn, `📥 ${project.title.substring(0,10)}... (${i + 1}/${projectConvIds.length})`);
                        const convData = await getConversation(projectConvIds[i], workspaceId);
                        await addConversationToZip(projectFolder, convData, workspaceId, attachmentReport);
                        await sleep(jitter());
                    }
                }
            }

            if (attachmentReport) {
                zip.file('attachment-export-report.json', JSON.stringify(attachmentReport, null, 2));
            }
            setFabStatus(btn, '📦 生成 ZIP 文件…');
            const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE" });
            const date = new Date().toISOString().slice(0, 10);
            const selectionType = exportType || ((Array.isArray(conversationEntries) && conversationEntries.length > 0) ? 'selected' : 'full');
            let filename = '';
            if (selectionType === 'selected') {
                filename = mode === 'team'
                    ? `chatgpt_team_selected_${workspaceId}_${date}.zip`
                    : mode === 'project'
                        ? `chatgpt_project_selected_${date}.zip`
                        : `chatgpt_personal_selected_${date}.zip`;
            } else {
                filename = mode === 'team'
                    ? `chatgpt_team_backup_${workspaceId}_${date}.zip`
                    : mode === 'project'
                        ? `chatgpt_project_backup_${date}.zip`
                        : `chatgpt_personal_backup_${date}.zip`;
            }
            downloadFile(blob, filename);
            const attachmentSummary = attachmentReport
                ? `\n附件：检测 ${attachmentReport.detected}，成功 ${attachmentReport.downloaded}，失败 ${attachmentReport.failed}。`
                : '';
            alert(`✅ 导出完成！${attachmentSummary}`);
            setFabStatus(btn, '✅ 完成');

        } catch (e) {
            console.error("导出过程中发生严重错误:", e);
            alert(`导出失败: ${e.message}。详情请查看控制台（F12 -> Console）。`);
            setFabStatus(btn, '⚠️ Error');
        } finally {
            setTimeout(() => {
                btn.disabled = false;
                setFabStatus(btn, EXPORT_BUTTON_LABEL);
            }, 3000);
        }
    }

    async function startExportProcess(mode, workspaceId, includeAttachments = false) {
        await exportConversations({ mode, workspaceId, includeAttachments });
    }

    async function startProjectSpaceExportProcess(workspaceId = null, includeAttachments = false) {
        try {
            const projectEntries = await listProjectSpaceConversations(workspaceId);
            if (projectEntries.length === 0) {
                alert('未找到项目空间对话。');
                return;
            }
            await exportConversations({
                mode: 'project',
                workspaceId,
                conversationEntries: projectEntries,
                exportType: 'full',
                includeAttachments
            });
        } catch (err) {
            console.error('导出项目空间失败:', err);
            alert(`导出项目空间失败: ${err.message}`);
        }
    }

    async function startSelectiveExportProcess(mode, workspaceId, conversationEntries, includeAttachments = false) {
        await exportConversations({ mode, workspaceId, conversationEntries, includeAttachments });
    }


    // --- 项目空间 API 辅助函数 ---
    function normalizeProjectSpaceItem(item) {
        const rawGizmo = item?.gizmo?.gizmo || item?.gizmo || item;
        const display = rawGizmo?.display || item?.gizmo?.display || item?.display;
        const id = rawGizmo?.id || item?.gizmo?.id || item?.id;
        const title = display?.name || rawGizmo?.name || 'Untitled Project';
        if (!id) return null;
        return {
            id,
            title,
            conversations: item?.conversations?.items || []
        };
    }

    function resolveWorkspaceId(workspaceId) {
        if (workspaceId) return workspaceId;
        const match = document.cookie.match(/(?:^|; )_account=([^;]+)/);
        if (match?.[1]) return match[1];
        const detectedIds = detectAllWorkspaceIds();
        return detectedIds.length > 0 ? detectedIds[0] : null;
    }

    async function getProjectSpaces(workspaceId, options = {}) {
        const deviceId = getOaiDeviceId();
        if (!deviceId) {
            throw new Error('无法获取 oai-device-id，请确保已登录并刷新页面。');
        }
        const headers = {
            'Authorization': `Bearer ${accessToken}`,
            'oai-device-id': deviceId
        };
        const resolvedWorkspaceId = resolveWorkspaceId(workspaceId);
        if (resolvedWorkspaceId) { headers['ChatGPT-Account-Id'] = resolvedWorkspaceId; }

        const projects = new Map();
        let cursor = null;

        do {
            const query = new URLSearchParams();
            query.set('limit', String(PROJECT_SIDEBAR_LIMIT));
            if (options.conversationsPerGizmo !== undefined) {
                query.set('conversations_per_gizmo', String(options.conversationsPerGizmo));
            }
            if (options.ownedOnly !== undefined) {
                query.set('owned_only', options.ownedOnly ? 'true' : 'false');
            }
            if (cursor) {
                query.set('cursor', cursor);
            }

            const r = await chBackendFetch(`/backend-api/gizmos/snorlax/sidebar?${query.toString()}`, { headers });
            if (!r.ok) {
                throw new Error(`获取项目空间列表失败 (${r.status})`);
            }
            const data = await r.json();
            data.items?.forEach(item => {
                const project = normalizeProjectSpaceItem(item);
                if (project) {
                    projects.set(project.id, project);
                }
            });
            cursor = data.cursor || null;
            if (cursor) {
                await sleep(jitter());
            }
        } while (cursor);

        return Array.from(projects.values());
    }

    async function getProjects(workspaceId) {
        if (!workspaceId) return [];
        try {
            const projects = await getProjectSpaces(workspaceId);
            return projects.map(({ id, title }) => ({ id, title }));
        } catch (err) {
            console.warn(`获取项目(Gizmo)列表失败 (${err?.message || err})`);
            return [];
        }
    }

    async function collectIds(btn, workspaceId, gizmoId) {
        const all = new Set();
        const deviceId = getOaiDeviceId();
        if (!deviceId) {
            throw new Error('无法获取 oai-device-id，请确保已登录并刷新页面。');
        }
        const headers = {
            'Authorization': `Bearer ${accessToken}`,
            'oai-device-id': deviceId
        };
        if (workspaceId) { headers['ChatGPT-Account-Id'] = workspaceId; }

        if (gizmoId) {
            let cursor = '0';
            do {
                const r = await chBackendFetch(`/backend-api/gizmos/${gizmoId}/conversations?cursor=${cursor}`, { headers });
                if (!r.ok) throw new Error(`列举项目对话列表失败 (${r.status})`);
                const j = await r.json();
                j.items?.forEach(it => all.add(it.id));
                cursor = j.cursor;
                await sleep(jitter());
            } while (cursor);
        } else {
            for (const is_archived of [false, true]) {
                let offset = 0, has_more = true, page = 0;
                do {
                    setFabStatus(btn, `📂 项目外对话 (${is_archived ? 'Archived' : 'Active'} p${++page})`);
                    const r = await chBackendFetch(`/backend-api/conversations?offset=${offset}&limit=${PAGE_LIMIT}&order=updated${is_archived ? '&is_archived=true' : ''}`, { headers });
                    if (!r.ok) throw new Error(`列举项目外对话列表失败 (${r.status})`);
                    const j = await r.json();
                    if (j.items && j.items.length > 0) {
                        j.items.forEach(it => all.add(it.id));
                        has_more = j.items.length === PAGE_LIMIT;
                        offset += j.items.length;
                    } else {
                        has_more = false;
                    }
                    await sleep(jitter());
                } while (has_more);
            }
        }
        return Array.from(all);
    }

    function upsertConversationEntry(map, item, extra = {}) {
        if (!item?.id) return;
        const create_time = normalizeEpochSeconds(item.create_time || 0);
        const update_time = normalizeEpochSeconds(item.update_time || item.create_time || 0);
        const entry = {
            id: item.id,
            title: item.title || 'Untitled Conversation',
            create_time,
            update_time,
            is_archived: item.is_archived ?? extra.is_archived ?? false,
            projectId: extra.projectId || null,
            projectTitle: extra.projectTitle || null
        };
        const existing = map.get(entry.id);
        if (!existing) {
            map.set(entry.id, entry);
            return;
        }
        if (!existing.projectTitle && entry.projectTitle) {
            existing.projectTitle = entry.projectTitle;
            existing.projectId = entry.projectId;
        }
        if (!existing.create_time && entry.create_time) {
            existing.create_time = entry.create_time;
        }
        existing.is_archived = existing.is_archived || entry.is_archived;
        if ((entry.update_time || 0) > (existing.update_time || 0)) {
            existing.update_time = entry.update_time;
        }
        if (existing.title === 'Untitled Conversation' && entry.title) {
            existing.title = entry.title;
        }
    }

    async function listConversations(workspaceId) {
        if (!await ensureAccessToken()) {
            throw new Error('无法获取 Access Token，请刷新页面或打开任意一个对话后再试。');
        }

        const deviceId = getOaiDeviceId();
        if (!deviceId) {
            throw new Error('无法获取 oai-device-id，请确保已登录并刷新页面。');
        }

        const headers = {
            'Authorization': `Bearer ${accessToken}`,
            'oai-device-id': deviceId
        };
        if (workspaceId) { headers['ChatGPT-Account-Id'] = workspaceId; }

        const map = new Map();
        const addEntry = (item, extra = {}) => upsertConversationEntry(map, item, extra);

        for (const is_archived of [false, true]) {
            let offset = 0;
            let has_more = true;
            do {
                const r = await chBackendFetch(`/backend-api/conversations?offset=${offset}&limit=${PAGE_LIMIT}&order=updated${is_archived ? '&is_archived=true' : ''}`, { headers });
                if (!r.ok) throw new Error(`列举对话列表失败 (${r.status})`);
                const j = await r.json();
                if (j.items && j.items.length > 0) {
                    j.items.forEach(it => addEntry(it, { is_archived }));
                    has_more = j.items.length === PAGE_LIMIT;
                    offset += j.items.length;
                } else {
                    has_more = false;
                }
                await sleep(jitter());
            } while (has_more);
        }

        if (workspaceId) {
            const projects = await getProjects(workspaceId);
            for (const project of projects) {
                let cursor = '0';
                do {
                    const r = await chBackendFetch(`/backend-api/gizmos/${project.id}/conversations?cursor=${cursor}`, { headers });
                    if (!r.ok) throw new Error(`列举项目对话列表失败 (${r.status})`);
                    const j = await r.json();
                    j.items?.forEach(it => addEntry(it, { projectId: project.id, projectTitle: project.title }));
                    cursor = j.cursor;
                    await sleep(jitter());
                } while (cursor);
            }
        }

        return Array.from(map.values())
            .sort((a, b) => (b.update_time || 0) - (a.update_time || 0));
    }

    async function listProjectSpaceConversations(workspaceId) {
        if (!await ensureAccessToken()) {
            throw new Error('无法获取 Access Token，请刷新页面或打开任意一个对话后再试。');
        }

        const deviceId = getOaiDeviceId();
        if (!deviceId) {
            throw new Error('无法获取 oai-device-id，请确保已登录并刷新页面。');
        }

        const headers = {
            'Authorization': `Bearer ${accessToken}`,
            'oai-device-id': deviceId
        };
        const resolvedWorkspaceId = resolveWorkspaceId(workspaceId);
        if (resolvedWorkspaceId) { headers['ChatGPT-Account-Id'] = resolvedWorkspaceId; }

        const map = new Map();
        const projects = await getProjectSpaces(resolvedWorkspaceId, { conversationsPerGizmo: PROJECT_SIDEBAR_PREVIEW, ownedOnly: true });

        for (const project of projects) {
            let cursor = '0';
            let fetched = false;
            do {
                const r = await chBackendFetch(`/backend-api/gizmos/${project.id}/conversations?cursor=${cursor}`, { headers });
                if (!r.ok) {
                    if (!fetched && Array.isArray(project.conversations) && project.conversations.length > 0) {
                        console.warn(`项目空间对话列表请求失败 (${r.status})，使用侧边栏返回的预览对话。`);
                        project.conversations.forEach(item => upsertConversationEntry(map, item, {
                            projectId: project.id,
                            projectTitle: project.title
                        }));
                        cursor = null;
                        break;
                    }
                    throw new Error(`列举项目空间对话列表失败 (${r.status})`);
                }
                const j = await r.json();
                j.items?.forEach(item => upsertConversationEntry(map, item, {
                    projectId: project.id,
                    projectTitle: project.title
                }));
                cursor = j.cursor;
                fetched = true;
                await sleep(jitter());
            } while (cursor);
        }

        return Array.from(map.values())
            .sort((a, b) => (b.update_time || 0) - (a.update_time || 0));
    }

    async function getConversation(id, workspaceId) {
        const deviceId = getOaiDeviceId();
        if (!deviceId) {
            throw new Error('无法获取 oai-device-id，请确保已登录并刷新页面。');
        }
        const headers = {
            'Authorization': `Bearer ${accessToken}`,
            'oai-device-id': deviceId
        };
        const resolvedWorkspaceId = resolveWorkspaceId(workspaceId);
        if (resolvedWorkspaceId) { headers['ChatGPT-Account-Id'] = resolvedWorkspaceId; }
        const r = await chBackendFetch(`/backend-api/conversation/${id}`, { headers });
        if (!r.ok) {
            if (r.status === 429) {
                throw new Error(`获取对话详情失败 conv ${id}：官方接口限流 (429)。请降低导出频率、减少单次导出的对话数量，等待几分钟后再试。`);
            }
            throw new Error(`获取对话详情失败 conv ${id} (${r.status})`);
        }
        const j = await r.json();
        j.__fetched_at = new Date().toISOString();
        return j;
    }

    // --- UI 相关函数 ---
    // (UI部分无变动，此处省略以保持简洁)
    /**
     * 检测当前页面与已捕获请求中的 Workspace ID。
     * @returns {string[]} - 返回包含所有唯一Workspace ID的数组
     */
    function detectAllWorkspaceIds() {
        const foundIds = new Set(capturedWorkspaceIds); // 从网络拦截的结果开始

        // 扫描 __NEXT_DATA__
        try {
            const data = JSON.parse(document.getElementById('__NEXT_DATA__').textContent);
            // 遍历所有账户信息
            const accounts = data?.props?.pageProps?.user?.accounts;
            if (accounts) {
                Object.values(accounts).forEach(acc => {
                    if (acc?.account?.id) {
                        foundIds.add(acc.account.id);
                    }
                });
            }
        } catch (e) {}

        // 扫描 localStorage
        try {
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                if (key && (key.includes('account') || key.includes('workspace'))) {
                    const value = localStorage.getItem(key);
                    if (value && /^[a-z0-9]{2,}-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value.replace(/"/g, ''))) {
                         const extractedId = value.match(/ws-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i);
                         if(extractedId) foundIds.add(extractedId[0]);
                    } else if (value && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value.replace(/"/g, ''))) {
                         foundIds.add(value.replace(/"/g, ''));
                    }
                }
            }
        } catch(e) {}

        console.log('🔍 检测到以下 Workspace IDs:', Array.from(foundIds));
        return Array.from(foundIds);
    }

    function showConversationPicker(options = {}) {
        const initialMode = options.mode || 'personal';
        const initialWorkspaceId = options.workspaceId || null;
        const initialAttachments = Boolean(options.includeAttachments);
        const existing = document.getElementById('export-dialog-overlay');
        if (existing) existing.remove();

        const overlay = document.createElement('div');
        overlay.id = 'export-dialog-overlay';
        Object.assign(overlay.style, {
            position: 'fixed', inset: '0', backgroundColor: 'rgba(0,0,0,.46)', zIndex: '99998',
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px', boxSizing: 'border-box'
        });

        const dialog = document.createElement('div');
        dialog.id = 'export-dialog';
        Object.assign(dialog.style, {
            background: '#fff', borderRadius: '12px', boxShadow: '0 18px 56px rgba(0,0,0,.30)',
            width: 'min(1240px, calc(100vw - 48px))', height: 'min(820px, calc(100vh - 48px))',
            minHeight: '560px', fontFamily: 'ui-sans-serif, system-ui, -apple-system, sans-serif',
            color: '#1f2937', boxSizing: 'border-box', overflow: 'hidden', display: 'flex', flexDirection: 'column'
        });

        const state = {
            mode: initialMode,
            workspaceId: initialWorkspaceId,
            list: [], filtered: [], selected: new Set(), query: '',
            projectFilter: 'all', archived: 'all', syncStatus: 'all', attachmentIntegrity: 'all',
            timeField: 'update', timeRange: 'all', sort: 'desc', startDate: '', endDate: '',
            loading: true, pageSize: 100, visibleCount: 100, includeAttachments: initialAttachments, retryFailedAttachments: false,
            networkPolicy: chLoadNetworkPolicy(), runSettings: null, rootHandle: null, savedRootHandle: null, localScan: null, lastPlan: null,
            layoutState: null, migrationActive: false, migrationReport: null,
            lastResult: null, syncStatusById: new Map(), lastSelectedIndex: null,
            remoteUniverse: [], remoteUniverseComplete: false, remoteUniverseNote: null,
            accountUniverse: null, accountUniverseComplete: false, accountUniverseNote: null,
            accountLoadedAt: null, teamUniverseCache: new Map(), remoteCacheMeta: null,
            remoteRefreshPromise: null, pendingRemoteSnapshot: null, remoteRefreshGeneration: 0, remoteAppliedValidatedAt: 0,
            loadingMessage: chT('正在加载云端对话…','Loading cloud conversations…'),
            remoteLoadedNoticeUntil: 0, remoteLoadedNoticeTimer: null
        };

        const userStatus = value => {
            if (['UNCHANGED','OBSERVATION_ONLY'].includes(value)) return 'SYNCED';
            if (['LOCAL_UNTRACKED','LOCAL_ONLY'].includes(value)) return 'CONFIRM';
            if (['ERROR','DUPLICATE'].includes(value)) return 'ERROR';
            if (value) return 'PENDING';
            return null;
        };
        const statusLabel = value => ({
            SYNCED: chT('已同步','Synced'), PENDING: chT('待同步','To sync'),
            CONFIRM: chT('需确认','Check'), ERROR: chT('异常','Error')
        }[userStatus(value) || value] || '');
        const statusColor = value => ({
            SYNCED:['#f0fdf4','#166534'], PENDING:['#eff6ff','#1d4ed8'],
            CONFIRM:['#fff7ed','#c2410c'], ERROR:['#fef2f2','#b91c1c']
        }[userStatus(value) || value] || ['#f3f4f6','#6b7280']);

        const closeDialog = () => {
            if (chSyncRun.active || state.migrationActive) {
                chSetProgress(
                    state.migrationActive ? chT('本地保存升级仍在运行','Local save upgrade is still running') : chT('同步仍在运行','Sync is still running'),
                    state.migrationActive ? chT('请等待当前整理步骤完成。','Wait for the current reorganization step to finish.') : chT('请先暂停或取消同步。','Pause or cancel sync first.'),
                    null
                );
                return;
            }
            overlay.remove();
        };

        dialog.innerHTML = `
            <div style="height:52px; padding:0 18px; border-bottom:1px solid #e5e7eb; display:flex; align-items:center; justify-content:space-between; flex:0 0 auto;">
                <div style="display:flex; align-items:baseline; gap:10px; min-width:0;">
                    <strong style="font-size:18px;">ChatHarbor</strong>
                    <span id="ch-header-summary" style="font-size:12px; color:#6b7280; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;"></span>
                </div>
                <div style="display:flex;gap:7px;"><button id="ch-refresh-btn" style="padding:7px 11px; border:1px solid #d1d5db; border-radius:7px; background:#fff; cursor:pointer;">${chT('刷新','Refresh')}</button><button id="back-btn" style="padding:7px 11px; border:1px solid #d1d5db; border-radius:7px; background:#fff; cursor:pointer;">${chT('关闭','Close')}</button></div>
            </div>
            <div style="padding:10px 14px; border-bottom:1px solid #e5e7eb; display:grid; grid-template-columns:minmax(230px,1fr) 110px 140px 110px 130px 145px 110px; gap:8px; align-items:center; flex:0 0 auto;">
                <input id="conv-search" type="text" placeholder="${chT('搜索对话或项目','Search conversations or projects')}" style="min-width:0; padding:8px 10px; border:1px solid #d1d5db; border-radius:7px;">
                <select id="ch-space-select" style="padding:8px; border:1px solid #d1d5db; border-radius:7px; background:#fff;">
                    <option value="personal">${chT('全部对话','All conversations')}</option><option value="project">${chT('项目对话','Project conversations')}</option><option value="team">${chT('团队空间','Team')}</option>
                </select>
                <select id="filter-project" style="padding:8px; border:1px solid #d1d5db; border-radius:7px; background:#fff;"><option value="all">${chT('项目：全部','Project: all')}</option></select>
                <select id="filter-archived" style="padding:8px; border:1px solid #d1d5db; border-radius:7px; background:#fff;">
                    <option value="all">${chT('归档：全部','Archive: all')}</option><option value="active">${chT('未归档','Active')}</option><option value="archived">${chT('已归档','Archived')}</option>
                </select>
                <select id="filter-sync-status" style="padding:8px; border:1px solid #d1d5db; border-radius:7px; background:#fff;">
                    <option value="all">${chT('状态：全部','Status: all')}</option>
                </select>
                <select id="filter-attachment-integrity" style="padding:8px; border:1px solid #d1d5db; border-radius:7px; background:#fff;">
                    <option value="all">${chT('附件：全部','Attachments: all')}</option>
                    <option value="complete">${chT('附件：完整','Attachments: complete')}</option>
                    <option value="issues">${chT('附件：有未归档','Attachments: not fully archived')}</option>
                </select>
                <details id="ch-time-menu" style="position:relative;">
                    <summary id="ch-time-summary" style="list-style:none; padding:8px; border:1px solid #d1d5db; border-radius:7px; background:#fff; cursor:pointer; text-align:center;">${chT('时间：不限','Time: all')}</summary>
                    <div style="position:absolute; right:0; top:40px; z-index:20; width:280px; padding:12px; background:#fff; border:1px solid #d1d5db; border-radius:9px; box-shadow:0 10px 28px rgba(0,0,0,.16);">
                        <label style="display:block; font-size:12px; color:#6b7280; margin-bottom:4px;">${chT('时间依据','Time field')}</label>
                        <select id="filter-time-field" style="width:100%; padding:7px; border:1px solid #d1d5db; border-radius:6px;"><option value="update">${chT('更新时间','Updated')}</option><option value="create">${chT('创建时间','Created')}</option></select>
                        <label style="display:block; font-size:12px; color:#6b7280; margin:10px 0 4px;">${chT('范围','Range')}</label>
                        <select id="filter-time-range" style="width:100%; padding:7px; border:1px solid #d1d5db; border-radius:6px;"><option value="all">${chT('不限','All')}</option><option value="7d">${chT('最近7天','Last 7 days')}</option><option value="30d">${chT('最近30天','Last 30 days')}</option><option value="custom">${chT('自定义','Custom')}</option></select>
                        <div id="ch-custom-date-row" style="display:none; grid-template-columns:1fr 1fr; gap:6px; margin-top:8px;"><input id="filter-start-date" type="date" style="min-width:0; padding:6px; border:1px solid #d1d5db; border-radius:6px;"><input id="filter-end-date" type="date" style="min-width:0; padding:6px; border:1px solid #d1d5db; border-radius:6px;"></div>
                        <label style="display:block; font-size:12px; color:#6b7280; margin:10px 0 4px;">${chT('排序','Sort')}</label>
                        <select id="filter-sort" style="width:100%; padding:7px; border:1px solid #d1d5db; border-radius:6px;"><option value="desc">${chT('最新优先','Newest first')}</option><option value="asc">${chT('最早优先','Oldest first')}</option></select>
                    </div>
                </details>
            </div>
            <div style="display:grid; grid-template-columns:minmax(0,1fr) 310px; gap:12px; padding:12px 14px 14px; flex:1 1 auto; min-height:0; background:#f8fafc;">
                <section style="min-width:0; min-height:0; display:flex; flex-direction:column;">
                    <div style="display:flex; justify-content:flex-start; align-items:center; gap:0; margin-bottom:8px; flex:0 0 auto; min-height:22px;">
                        <label style="display:flex;align-items:center;gap:6px;min-width:72px;font-size:12px;color:#374151;cursor:pointer;white-space:nowrap;"><input id="select-all-checkbox" type="checkbox"><span id="select-all-label">${chT('全选','Select all')}</span></label>
                        <div id="conv-status" style="margin-left:24px;font-size:12px;color:#6b7280;white-space:nowrap;">${chT('正在加载列表…','Loading…')}</div>
                    </div>
                    <div id="conv-list" style="flex:1 1 auto; min-height:0; overflow:auto; border:1px solid #e5e7eb; border-radius:9px; padding:8px; background:#fff;"></div>
                </section>
                <aside style="min-height:0; overflow:hidden; display:flex; flex-direction:column; gap:9px;">
                    <div id="ch-right-scroll" style="min-height:0; flex:1 1 auto; overflow:auto; display:flex; flex-direction:column; gap:9px; padding-right:1px;">
                        <div style="padding:10px; border:1px solid #d1d5db; border-radius:9px; background:#fff;">
                            <div style="display:flex;justify-content:space-between;gap:8px;align-items:center;"><strong style="font-size:13px;">${chT('本地保存','Local save')}</strong><button id="ch-archive-copy-report-btn" style="display:none;padding:3px 7px;border:1px solid #d1d5db;border-radius:6px;background:#fff;color:#6b7280;cursor:pointer;font-size:11px;">${chT('详情','Details')}</button></div>
                            <div id="ch-archive-path" style="margin-top:6px; font-size:12px; color:#6b7280; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${chT('第一步：选择本地保存位置','Step 1: choose a local save location')}</div>
                            <div id="ch-archive-summary" style="margin-top:6px; font-size:12px; line-height:1.55; color:#4b5563;">${chT('选好后会自动检查已有文件。','Existing files will be checked automatically.')}</div>
                            <div style="display:flex; gap:6px; margin-top:8px;"><button id="ch-choose-directory-btn" style="flex:1; padding:7px 8px; border:1px solid #d1d5db; border-radius:6px; background:#fff; cursor:pointer;">${chT('选择目录','Choose')}</button><button id="preflight-plan-btn" style="flex:1; padding:7px 8px; border:1px solid #6366f1; border-radius:6px; background:#fff; color:#4338ca; cursor:pointer; font-weight:600;">${chT('重新检查','Check again')}</button></div>
                            <button id="ch-migrate-layout-btn" style="display:none;width:100%;margin-top:7px;padding:8px 10px;border:1px solid #d97706;border-radius:7px;background:#fffbeb;color:#92400e;cursor:pointer;font-weight:700;">${chT('升级本地保存结构','Upgrade local save structure')}</button>
                        </div>
                        <details style="padding:9px 10px; border:1px solid #d1d5db; border-radius:9px; background:#fff;">
                            <summary id="ch-network-policy-summary" style="cursor:pointer; font-size:13px; font-weight:600;">${chT('请求速度','Request speed')} · ${chNetworkPolicySummary(state.networkPolicy)}</summary>
                            <div id="ch-network-policy-lock-note" style="display:none;margin-top:7px;font-size:11px;color:#6b7280;">${chT('本次同步期间不可修改','Locked during this sync')}</div>
                            <label style="display:block;font-size:11px;color:#6b7280;margin-top:8px;">${chT('使用场景','Use case')}<select id="ch-speed-level" style="width:100%;margin-top:3px;padding:6px;border:1px solid #d1d5db;border-radius:6px;">${CH_SPEED_LEVELS.map((x,i)=>`<option value="${i}" ${i===state.networkPolicy.speedIndex?'selected':''}>${x.name}</option>`).join('')}</select></label>
                            <div id="ch-network-policy-detail" style="margin-top:6px;font-size:11px;color:#6b7280;line-height:1.45;">${chNetworkPolicyDetail(state.networkPolicy)}</div>
                            <div style="margin-top:5px;font-size:10.5px;color:#9ca3af;line-height:1.45;">${chT('出现“请求过多”时，建议改用“保守模式（最稳）”。','After a “too many requests” warning, use “Conservative mode (safest)”.')}</div>
                            <details style="margin-top:7px;">
                                <summary style="cursor:pointer;font-size:11px;color:#6b7280;">${chT('高级设置','Advanced settings')}</summary>
                                <div style="display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-top:7px;">
                                    <label style="font-size:11px;color:#6b7280;">${chT('每批会话数','Conversations per batch')}<input id="ch-batch-size" type="number" min="1" max="200" value="${state.networkPolicy.batchSize}" style="width:100%;box-sizing:border-box;margin-top:3px;padding:6px;border:1px solid #d1d5db;border-radius:6px;"></label>
                                    <span></span>
                                    <label style="font-size:11px;color:#6b7280;">${chT('最短休息(秒)','Minimum break (s)')}<input id="ch-pause-min" type="number" min="0" max="3600" value="${state.networkPolicy.batchPauseMinSec}" style="width:100%;box-sizing:border-box;margin-top:3px;padding:6px;border:1px solid #d1d5db;border-radius:6px;"></label>
                                    <label style="font-size:11px;color:#6b7280;">${chT('最长休息(秒)','Maximum break (s)')}<input id="ch-pause-max" type="number" min="0" max="3600" value="${state.networkPolicy.batchPauseMaxSec}" style="width:100%;box-sizing:border-box;margin-top:3px;padding:6px;border:1px solid #d1d5db;border-radius:6px;"></label>
                                </div>
                            </details>
                        </details>
                        <details style="padding:9px 10px; border:1px solid #d1d5db; border-radius:9px; background:#fff;">
                            <summary id="ch-sync-content-summary" style="cursor:pointer; font-size:13px; font-weight:600;">${chT('附件','Attachments')} · ${state.includeAttachments?chT('下载','Download'):chT('不下载','Do not download')}</summary>
                            <div id="ch-sync-content-lock-note" style="display:none;margin-top:7px;font-size:11px;color:#6b7280;">${chT('本次同步期间不可修改','Locked during this sync')}</div>
                            <label style="display:flex; gap:7px; align-items:flex-start; margin-top:8px; font-size:12px; cursor:pointer;"><input id="include-attachments-picker" type="checkbox" ${state.includeAttachments?'checked':''}><span>${chT('同时下载上传和生成的附件','Download uploads and generated files')}<small style="display:block;color:#6b7280;margin-top:2px;">${chT('默认关闭；开启后处理时间与本地占用可能明显增加。','Off by default; increases processing time and local storage.')}</small></span></label>
                            <label style="display:flex; gap:7px; align-items:flex-start; margin:7px 0 0 24px; font-size:12px; cursor:pointer;"><input id="retry-failed-attachments-picker" type="checkbox" ${state.retryFailedAttachments?'checked':''} ${state.includeAttachments?'':'disabled'}><span>${chT('重试以前下载失败的附件','Retry previously failed attachments')}<small style="display:block;color:#6b7280;margin-top:2px;">${chT('默认关闭；只在本次同步中生效。','Off by default; applies to this sync only.')}</small></span></label>
                        </details>
                        <div id="ch-sync-progress" style="display:none; padding:10px; border:1px solid #d1d5db; border-radius:9px; background:#fff;">
                            <div style="display:flex;justify-content:space-between;gap:8px;align-items:center;font-size:12px;"><strong id="ch-sync-progress-primary"></strong><span id="ch-sync-progress-pct" style="color:#6b7280;"></span></div>
                            <div style="height:6px;margin-top:7px;background:#e5e7eb;border-radius:999px;overflow:hidden;"><div id="ch-sync-progress-bar" style="width:0%;height:100%;background:#10a37f;border-radius:999px;transition:width .18s ease;"></div></div>
                            <div id="ch-sync-progress-secondary" style="margin-top:6px;font-size:11px;color:#6b7280;line-height:1.45;"></div>
                            <div style="display:flex;justify-content:flex-end;gap:6px;margin-top:8px;"><button id="ch-pause-sync-btn" style="display:none;padding:5px 9px;border:1px solid #6366f1;border-radius:6px;background:#fff;color:#4338ca;cursor:pointer;">${chT('暂停','Pause')}</button><button id="ch-cancel-sync-btn" style="display:none;padding:5px 9px;border:1px solid #dc2626;border-radius:6px;background:#fff;color:#b91c1c;cursor:pointer;">${chT('取消同步','Cancel sync')}</button></div>
                        </div>
                        <div id="ch-result-panel" style="display:none; padding:9px 10px; border:1px solid #bbf7d0; border-radius:9px; background:#f0fdf4;">
                            <div style="display:flex;justify-content:space-between;gap:8px;align-items:center;"><strong id="ch-result-title" style="font-size:13px;"></strong><button id="ch-copy-report-btn" style="padding:3px 7px;border:1px solid #d1d5db;border-radius:6px;background:#fff;cursor:pointer;font-size:11px;">${chT('复制详细报告','Copy details')}</button></div><pre id="ch-result-summary" style="margin:6px 0 0;white-space:pre-wrap;font:11px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:#374151;"></pre>
                        </div>
                    </div>
                    <div id="ch-action-bar" style="flex:0 0 auto; padding:9px; border:1px solid #d1d5db; border-radius:9px; background:#fff; box-shadow:0 -4px 16px rgba(15,23,42,.04);">
                        <button id="sync-directory-btn" style="width:100%;padding:12px 14px;border:none;border-radius:7px;background:#10a37f;color:#fff;cursor:pointer;font-weight:700;white-space:nowrap;">${chT('同步选中','Sync selected')}</button>
                    </div>
                </aside>
            </div>`;

        overlay.appendChild(dialog);
        document.body.appendChild(overlay);

        const $ = id => dialog.querySelector(`#${id}`);
        const searchInput = $('conv-search');
        const spaceSelect = $('ch-space-select');
        const projectSelect = $('filter-project');
        const archivedSelect = $('filter-archived');
        const syncStatusSelect = $('filter-sync-status');
        const timeFieldSelect = $('filter-time-field');
        const timeRangeSelect = $('filter-time-range');
        const sortSelect = $('filter-sort');
        const startDateInput = $('filter-start-date');
        const endDateInput = $('filter-end-date');
        const customDateRow = $('ch-custom-date-row');
        const timeSummary = $('ch-time-summary');
        const includeAttachmentsInput = $('include-attachments-picker');
        const retryFailedAttachmentsInput = $('retry-failed-attachments-picker');
        const chooseDirBtn = $('ch-choose-directory-btn');
        const preflightBtn = $('preflight-plan-btn');
        const migrateLayoutBtn = $('ch-migrate-layout-btn');
        const syncSelectedBtn = $('sync-directory-btn');
        const selectAllCheckbox = $('select-all-checkbox');
        const selectAllLabel = $('select-all-label');
        const refreshBtn = $('ch-refresh-btn');
        const closeBtn = $('back-btn');
        const pauseSyncBtn = $('ch-pause-sync-btn');
        const cancelSyncBtn = $('ch-cancel-sync-btn');
        const speedLevelInput = $('ch-speed-level');
        const batchSizeInput = $('ch-batch-size');
        const pauseMinInput = $('ch-pause-min');
        const pauseMaxInput = $('ch-pause-max');
        const networkSummary = $('ch-network-policy-summary');
        const networkDetail = $('ch-network-policy-detail');
        const networkLockNote = $('ch-network-policy-lock-note');
        const syncContentSummary = $('ch-sync-content-summary');
        const syncContentLockNote = $('ch-sync-content-lock-note');
        const archiveCopyReportBtn = $('ch-archive-copy-report-btn');
        const attachmentIntegritySelect = $('filter-attachment-integrity');

        spaceSelect.value = state.mode;
        archivedSelect.value = state.archived;


        const attachmentInfoForItem = item => {
            const record = state.localScan?.recordsById?.get(item?.id) || null;
            if (!record || record.tracking !== 'manifest') return { record, failures: [], success: 0, detected: 0, missing: 0, hasIssue: false, state: 'unknown' };
            const failures = chAttachmentFailureDisplayList(record);
            const success = Array.isArray(record.assets) ? record.assets.length : Number(record.attachment_downloaded || 0);
            const detected = Number(record.attachment_detected || 0);
            const missing = Math.max(failures.length, detected > success ? detected - success : 0);
            const attachmentState = chRecordAttachmentState(record);
            return { record, failures, success, detected, missing, hasIssue: failures.length > 0 || attachmentState === 'partial' || attachmentState === 'not_downloaded', state: attachmentState };
        };
        const attachmentSourceGroup = category => category === 'user_upload' ? 'user' : ['assistant_generated_deliverable','generated_media','assistant_asset'].includes(category) ? 'generated' : 'unknown';
        const showAttachmentDetails = item => {
            const info = attachmentInfoForItem(item);
            if (!info.record) return;
            const existing = document.getElementById('ch-attachment-detail-overlay');
            if (existing) existing.remove();
            const failures = info.failures;
            const detailOverlay = document.createElement('div');
            detailOverlay.id = 'ch-attachment-detail-overlay';
            detailOverlay.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,.38);z-index:100002;display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box;';
            const panel = document.createElement('div');
            panel.style.cssText = 'width:min(860px,calc(100vw - 48px));max-height:min(720px,calc(100vh - 48px));background:#fff;border-radius:12px;box-shadow:0 20px 60px rgba(0,0,0,.28);display:flex;flex-direction:column;overflow:hidden;color:#1f2937;';
            const header = document.createElement('div');
            header.style.cssText = 'padding:14px 16px;border-bottom:1px solid #e5e7eb;display:flex;gap:12px;align-items:center;justify-content:space-between;';
            const headerText = document.createElement('div'); headerText.style.minWidth='0';
            const title = document.createElement('div'); title.textContent = item.title || info.record.title || 'Untitled Conversation'; title.title=title.textContent; title.style.cssText='font-weight:700;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
            const summary = document.createElement('div'); summary.textContent = `${chT('附件归档','Attachment archive')}: ${chT('成功','Archived')} ${info.success} · ${chT('未成功','Not archived')} ${info.missing}`; summary.style.cssText='font-size:12px;color:#6b7280;margin-top:3px;';
            headerText.append(title,summary);
            const headerActions = document.createElement('div'); headerActions.style.cssText='display:flex;gap:7px;flex:0 0 auto;';
            const openBtn = document.createElement('button'); openBtn.textContent=chT('打开原会话','Open original conversation'); openBtn.style.cssText='padding:7px 10px;border:1px solid #c7d2fe;border-radius:7px;background:#eef2ff;color:#3730a3;cursor:pointer;font-size:12px;'; openBtn.onclick=()=>window.open(`https://chatgpt.com/c/${encodeURIComponent(item.id)}`,'_blank','noopener,noreferrer');
            const closeDetail = document.createElement('button'); closeDetail.textContent=chT('关闭','Close'); closeDetail.style.cssText='padding:7px 10px;border:1px solid #d1d5db;border-radius:7px;background:#fff;cursor:pointer;font-size:12px;'; closeDetail.onclick=()=>detailOverlay.remove();
            headerActions.append(openBtn,closeDetail); header.append(headerText,headerActions);
            const body = document.createElement('div'); body.style.cssText='padding:12px 16px 14px;overflow:auto;min-height:0;';
            const sectionTitle=document.createElement('div');sectionTitle.textContent=chT('未成功归档附件','Attachments not successfully archived');sectionTitle.style.cssText='font-size:12px;font-weight:700;margin-bottom:8px;';body.appendChild(sectionTitle);
            let activeFilter='all';
            const listWrap=document.createElement('div');
            const filterWrap=document.createElement('div'); filterWrap.style.cssText='display:flex;gap:6px;margin:0 0 8px;';
            const renderFailures=()=>{
                listWrap.innerHTML='';
                const columnHeader=document.createElement('div');
                columnHeader.style.cssText='position:sticky;top:-12px;z-index:2;display:grid;grid-template-columns:minmax(0,1fr) 104px 92px 112px 20px;gap:8px;align-items:center;padding:6px 4px;border-bottom:1px solid #e5e7eb;background:rgba(255,255,255,.97);font-size:10px;font-weight:650;color:#6b7280;';
                [chT('文件名','File'),chT('来源','Source'),chT('原始错误','Raw error'),chT('阶段','Stage'),''].forEach(label=>{const cell=document.createElement('span');cell.textContent=label;cell.style.cssText='white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';columnHeader.appendChild(cell);});
                listWrap.appendChild(columnHeader);
                const visible=failures.filter(f=>activeFilter==='all'||attachmentSourceGroup(f.source_category)===activeFilter);
                if(!visible.length){const empty=document.createElement('div');empty.textContent=chT('没有对应的未成功归档附件。','No matching unarchived attachments.');empty.style.cssText='padding:10px;color:#9ca3af;font-size:12px;';listWrap.appendChild(empty);return;}
                visible.forEach(failure=>{
                    const row=document.createElement('div');row.style.cssText='border-top:1px solid #eef2f7;';
                    const head=document.createElement('button');head.type='button';head.style.cssText='width:100%;display:grid;grid-template-columns:minmax(0,1fr) 104px 92px 112px 20px;gap:8px;align-items:center;padding:8px 4px;border:0;background:#fff;text-align:left;cursor:pointer;color:#1f2937;';
                    const name=document.createElement('span');name.textContent=failure.name||chT('未命名附件','Unnamed attachment');name.title=name.textContent;name.style.cssText='font-size:12px;font-weight:650;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
                    const source=document.createElement('span');source.textContent=chAttachmentSourceLabel(failure.source_category);source.style.cssText='font-size:11px;color:#4b5563;white-space:nowrap;';
                    const errorInfo=chAttachmentErrorInfo(failure.error);const error=document.createElement('span');error.textContent=`${errorInfo.short} ⓘ`;error.title=errorInfo.explanation;error.tabIndex=0;error.style.cssText='font-size:11px;color:#92400e;white-space:nowrap;';
                    const stage=document.createElement('span');stage.textContent=chAttachmentFailureStage(failure.error);stage.style.cssText='font-size:11px;color:#6b7280;white-space:nowrap;';
                    const arrow=document.createElement('span');arrow.textContent='›';arrow.style.cssText='font-size:17px;color:#9ca3af;text-align:center;';
                    const detail=document.createElement('div');detail.style.cssText='display:none;padding:0 4px 9px 4px;font-size:11px;line-height:1.55;color:#4b5563;';
                    const identity=failure.file_id||failure.sandbox_path||'-';
                    detail.textContent=[`${chT('通道','Kind')}: ${failure.reference_kind||failure.kind||'-'}`,`${chT('来源','Source')}: ${chAttachmentSourceLabel(failure.source_category)}`,`${chT('最近尝试','Last attempt')}: ${failure.attempted_at?chFormatLocalTimestamp(failure.attempted_at):chT('历史记录未保存尝试时间','historical record has no attempt timestamp')}`,`${chT('附件标识','Attachment identity')}: ${identity}`,`${chT('原始错误','Raw error')}: ${failure.error||'-'}`,`${chT('状态','Status')}: ${chT('当前未成功归档','currently not successfully archived')}`].join('\n');detail.style.whiteSpace='pre-wrap';detail.style.wordBreak='break-word';
                    head.append(name,source,error,stage,arrow);head.onclick=()=>{const open=detail.style.display!=='none';detail.style.display=open?'none':'block';arrow.textContent=open?'›':'⌄';};row.append(head,detail);listWrap.appendChild(row);
                });
            };
            if(failures.length>=6){
                const counts={all:failures.length,user:failures.filter(f=>attachmentSourceGroup(f.source_category)==='user').length,generated:failures.filter(f=>attachmentSourceGroup(f.source_category)==='generated').length};
                [['all',`${chT('全部','All')} ${counts.all}`],['user',`${chT('用户上传','User uploads')} ${counts.user}`],['generated',`${chT('ChatGPT生成','ChatGPT generated')} ${counts.generated}`]].forEach(([value,label])=>{if(value!=='all'&&!counts[value])return;const b=document.createElement('button');b.type='button';b.textContent=label;b.style.cssText='padding:4px 8px;border:1px solid #d1d5db;border-radius:999px;background:#fff;cursor:pointer;font-size:11px;';b.onclick=()=>{activeFilter=value;[...filterWrap.children].forEach(x=>x.style.background='#fff');b.style.background='#eef2ff';renderFailures();};filterWrap.appendChild(b);});
                if(filterWrap.firstChild)filterWrap.firstChild.style.background='#eef2ff';body.appendChild(filterWrap);
            }
            renderFailures();body.appendChild(listWrap);
            if(info.hasIssue && failures.length===0){const gapNote=document.createElement('div');gapNote.textContent=chT('当前记录显示附件未完整，但没有可逐项定位的失败证据；ChatHarbor 不推断具体缺失文件。可打开原会话进一步核查。','This conversation is not fully archived, but no per-file failure evidence is available. ChatHarbor does not infer a specific missing file; open the original conversation to review it.');gapNote.style.cssText='margin-top:8px;padding:8px 10px;border-radius:7px;background:#fff7ed;color:#9a3412;font-size:11px;line-height:1.5;';body.appendChild(gapNote);}
            const guidance=document.createElement('div');guidance.style.cssText='margin-top:10px;padding-top:9px;border-top:1px solid #e5e7eb;font-size:11px;line-height:1.5;color:#6b7280;';
            const notes=[];if(failures.some(f=>f.source_category==='user_upload'))notes.push(chT('重要的用户上传文件可先打开原会话检查，也可按文件名在原电脑、NAS、网盘或 Everything 等本地文件搜索工具中查找原件。','For important user-uploaded files, check the original conversation or search the original computer, NAS, cloud drive, or a local file-search tool by filename.'));if(failures.some(f=>attachmentSourceGroup(f.source_category)==='generated'))notes.push(chT('ChatGPT生成文件可回原会话检查原始链接；必要时可尝试重新生成，但重新生成内容不保证完全一致。','For ChatGPT-generated files, check the original conversation; regeneration may be possible but is not guaranteed to reproduce identical content.'));guidance.textContent=notes.join(' ');if(notes.length)body.appendChild(guidance);
            panel.append(header,body);detailOverlay.appendChild(panel);detailOverlay.onclick=e=>{if(e.target===detailOverlay)detailOverlay.remove();};document.body.appendChild(detailOverlay);
        };

        const updateHeader = () => {
            $('ch-header-summary').textContent = `v${CH_PRODUCT_VERSION} · ${CH_PROVIDER_LABEL}`;
        };
        const updateTimeSummary = () => {
            const range = state.timeRange === '7d' ? chT('最近7天','7 days') : state.timeRange === '30d' ? chT('最近30天','30 days') : state.timeRange === 'custom' ? chT('自定义','Custom') : chT('不限','All');
            timeSummary.textContent = `${chT('时间','Time')}：${range}`;
            customDateRow.style.display = state.timeRange === 'custom' ? 'grid' : 'none';
        };
        const statusMatches = status => {
            if (state.syncStatus === 'all') return true;
            return userStatus(status) === state.syncStatus;
        };
        const projectKey = item => item.projectId ? `id:${item.projectId}` : item.projectTitle ? `title:${item.projectTitle}` : item.__chProjectState === 'unknown' ? 'unknown' : 'none';

        const rebuildProjectOptions = () => {
            const current = state.projectFilter;
            const map = new Map();
            for (const item of state.list) if (item.projectTitle) map.set(projectKey(item), item.projectTitle);
            projectSelect.innerHTML = '';
            const add = (value, label) => { const o=document.createElement('option');o.value=value;o.textContent=label;projectSelect.appendChild(o); };
            add('all', chT('项目：全部','Project: all'));
            add('none', chT('无项目','No project'));
            if (state.list.some(item => projectKey(item) === 'unknown')) add('unknown', chT('归属未知','Unknown project'));
            [...map.entries()].sort((a,b)=>a[1].localeCompare(b[1])).forEach(([value,label])=>add(value,label));
            state.projectFilter = [...projectSelect.options].some(o=>o.value===current) ? current : 'all';
            projectSelect.value = state.projectFilter;
        };
        const rebuildSyncOptions = () => {
            const current = state.syncStatus;
            const counts = {SYNCED:0,PENDING:0,CONFIRM:0,ERROR:0};
            state.list.forEach(item => { const u=userStatus(state.syncStatusById.get(item.id)); if(u) counts[u]++; });
            const options = [
                ['all', `${chT('状态：全部','Status: all')} (${state.list.length})`],
                ['SYNCED', `${chT('已同步','Synced')} (${counts.SYNCED})`],
                ['PENDING', `${chT('待同步','To sync')} (${counts.PENDING})`],
                ['CONFIRM', `${chT('需确认','Check')} (${counts.CONFIRM})`],
                ['ERROR', `${chT('异常','Error')} (${counts.ERROR})`]
            ];
            syncStatusSelect.innerHTML='';
            options.forEach(([value,label])=>{const o=document.createElement('option');o.value=value;o.textContent=label;syncStatusSelect.appendChild(o);});
            state.syncStatus = options.some(x=>x[0]===current) ? current : 'all';
            syncStatusSelect.value = state.syncStatus;
        };


        const rebuildAttachmentOptions = () => {
            if (!attachmentIntegritySelect) return;
            const current = state.attachmentIntegrity;
            let complete = 0, issues = 0;
            for (const item of state.list) {
                const info = attachmentInfoForItem(item);
                if (!info.record) continue;
                if (info.hasIssue) issues++; else if (['complete','none'].includes(info.state)) complete++;
            }
            const options = [
                ['all', `${chT('附件：全部','Attachments: all')} (${state.list.length})`],
                ['complete', `${chT('附件：完整','Attachments: complete')} (${complete})`],
                ['issues', `${chT('附件：有未归档','Attachments: not fully archived')} (${issues})`]
            ];
            attachmentIntegritySelect.innerHTML='';
            options.forEach(([value,label])=>{const o=document.createElement('option');o.value=value;o.textContent=label;attachmentIntegritySelect.appendChild(o);});
            state.attachmentIntegrity = options.some(x=>x[0]===current) ? current : 'all';
            attachmentIntegritySelect.value = state.attachmentIntegrity;
        };
        const applyFilters = () => {
            const query = state.query.trim().toLowerCase();
            const now = Date.now()/1000;
            let startBound = null, endBound = null;
            if (state.timeRange === '7d') startBound = now - 7*86400;
            else if (state.timeRange === '30d') startBound = now - 30*86400;
            else if (state.timeRange === 'custom') { startBound=parseDateInputToEpoch(state.startDate,false); endBound=parseDateInputToEpoch(state.endDate,true); }
            state.filtered = state.list.filter(item => {
                const hay = `${item.title||''} ${item.projectTitle||''} ${item.id||''}`.toLowerCase();
                if (query && !hay.includes(query)) return false;
                if (state.projectFilter !== 'all' && projectKey(item) !== state.projectFilter) return false;
                if (state.archived === 'active' && item.is_archived) return false;
                if (state.archived === 'archived' && !item.is_archived) return false;
                if (!statusMatches(state.syncStatusById.get(item.id))) return false;
                if (state.attachmentIntegrity !== 'all') {
                    const info = attachmentInfoForItem(item);
                    if (state.attachmentIntegrity === 'issues' && !info.hasIssue) return false;
                    if (state.attachmentIntegrity === 'complete' && (!info.record || !['complete','none'].includes(info.state))) return false;
                }
                const ts = normalizeEpochSeconds(state.timeField === 'create' ? item.create_time : item.update_time);
                if (startBound && (!ts || ts < startBound)) return false;
                if (endBound && (!ts || ts > endBound)) return false;
                return true;
            }).sort((a,b)=>{
                const ta=normalizeEpochSeconds(state.timeField==='create'?a.create_time:a.update_time)||0;
                const tb=normalizeEpochSeconds(state.timeField==='create'?b.create_time:b.update_time)||0;
                return state.sort==='asc' ? ta-tb : tb-ta;
            });
            // Selection always follows the result the user can currently see.
            const filteredIds = new Set(state.filtered.map(item => item.id));
            for (const id of Array.from(state.selected)) if (!filteredIds.has(id)) state.selected.delete(id);
            state.lastSelectedIndex = null;
            state.visibleCount = state.pageSize;
        };
        const hasActiveFilters = () => Boolean(
            state.query.trim() || state.projectFilter !== 'all' || state.archived !== 'all' ||
            state.syncStatus !== 'all' || state.attachmentIntegrity !== 'all' || state.timeRange !== 'all'
        );
        const updateArchiveSummary = () => {
            $('ch-archive-path').textContent = state.rootHandle?.name ? `${chT('保存到','Save to')}：${state.rootHandle.name}` : state.savedRootHandle ? chT('需要继续使用上次保存位置','Continue with the previous save location') : chT('第一步：选择本地保存位置','Step 1: choose a local save location');
            const layout = state.layoutState;
            if (!state.rootHandle) {
                $('ch-archive-summary').textContent = state.savedRootHandle ? chT('点击“继续使用”后会自动检查已有文件。','Click “Continue” and existing files will be checked automatically.') : chT('选好后会自动检查已有文件。','Existing files will be checked automatically.');
            } else if (layout?.requiresMigration) {
                $('ch-archive-summary').textContent = `${chT('本地保存结构需要升级','Local save structure needs an upgrade')} · ${chT('共','Total')} ${layout.total || 0}`;
            } else if (!state.lastPlan) {
                $('ch-archive-summary').textContent = `${chT('已选择保存位置','Save location selected')} · ${chT('等待检查','waiting to check')}`;
            } else {
                const s = state.lastPlan.summary;
                const localOnly = s.localOnlyReliable ? Math.max(0, Number(s.localOnlyCount || 0)) : 0;
                const issues = Math.max(0, Number(s.errorCount || 0) + Number(s.duplicateIdCount || 0));
                const parts = [chT('本地保存位置已检查','Save location checked')];
                if (localOnly) parts.push(`${chT('仅本地记录需确认','Local-only records to review')} ${localOnly}`);
                if (issues) parts.push(`${chT('检查发现异常','Issues found')} ${issues}`);
                $('ch-archive-summary').textContent = parts.join(' · ');
            }
            if (migrateLayoutBtn) {
                migrateLayoutBtn.style.display = layout?.requiresMigration ? '' : 'none';
                migrateLayoutBtn.textContent = layout?.migrationInProgress ? chT('继续升级本地保存结构','Continue upgrade') : chT('升级本地保存结构','Upgrade local save');
            }
            if (archiveCopyReportBtn) archiveCopyReportBtn.style.display = state.lastPlan ? '' : 'none';
            updateHeader();
        };
        const updateSettingsSummary = () => {
            const runLocked = Boolean(chSyncRun.active && state.runSettings);
            const policy = runLocked ? chSyncRun.policy : state.networkPolicy;
            const includeAttachments = runLocked ? Boolean(state.runSettings.includeAttachments) : Boolean(state.includeAttachments);
            const retryFailedAttachments = runLocked ? Boolean(state.runSettings.retryFailedAttachments) : Boolean(state.retryFailedAttachments);
            if (networkSummary) networkSummary.textContent = `${chT('请求速度','Request speed')} · ${chNetworkPolicySummary(policy)}`;
            if (networkDetail) networkDetail.textContent = chNetworkPolicyDetail(policy);
            const attachmentStats = state.lastPlan?.summary?.attachmentStates;
            const attachmentLocal = attachmentStats ? ` · ${chT('本地','Local')}: ${chT('完整','Complete')} ${attachmentStats.complete||0} · ${chT('不完整','Partial')} ${attachmentStats.partial||0} · ${chT('失败附件','Failed attachments')} ${attachmentStats.failed||0}` : '';
            if (syncContentSummary) syncContentSummary.textContent = `${chT('附件','Attachments')} · ${includeAttachments ? chT('下载','Download') : chT('不下载','Do not download')} · ${!includeAttachments ? chT('附件未纳入本次同步判断','Attachments are not included in this sync check') : retryFailedAttachments ? chT('本次同时重试历史失败附件','Retry historical failed attachments this run') : chT('处理新附件；历史失败默认不重复重试','Process new attachments; historical failures are not retried by default')}${attachmentLocal}`;
            if (networkLockNote) networkLockNote.style.display = runLocked ? '' : 'none';
            if (syncContentLockNote) syncContentLockNote.style.display = runLocked ? '' : 'none';
        };
        const updateControls = () => {
            const disabled = state.loading || chSyncRun.active || state.migrationActive;
            const migrationRequired = Boolean(state.layoutState?.requiresMigration);
            [searchInput,spaceSelect,projectSelect,archivedSelect,syncStatusSelect,attachmentIntegritySelect,timeFieldSelect,timeRangeSelect,sortSelect,startDateInput,endDateInput,refreshBtn].forEach(el=>{if(el)el.disabled=disabled;});
            const runLocked = Boolean(chSyncRun.active);
            [speedLevelInput,batchSizeInput,pauseMinInput,pauseMaxInput,includeAttachmentsInput,retryFailedAttachmentsInput].forEach(el=>{if(el)el.disabled=runLocked||(el===retryFailedAttachmentsInput&&!state.includeAttachments);});
            updateSettingsSummary();
            chooseDirBtn.disabled = chSyncRun.active || state.migrationActive;
            chooseDirBtn.textContent = state.rootHandle ? chT('更换目录','Change location') : state.savedRootHandle ? chT('继续使用','Continue') : chT('选择位置','Choose location');
            chooseDirBtn.title = state.rootHandle ? chT('切换本地保存位置。','Change the local save location.') : '';
            const needsSaveLocation = !state.rootHandle;
            chooseDirBtn.style.borderColor = needsSaveLocation ? '#4f46e5' : '#d1d5db';
            chooseDirBtn.style.background = needsSaveLocation ? '#eef2ff' : '#fff';
            chooseDirBtn.style.color = needsSaveLocation ? '#3730a3' : '#111827';
            chooseDirBtn.style.fontWeight = needsSaveLocation ? '700' : '400';
            preflightBtn.style.display = state.rootHandle ? '' : 'none';
            preflightBtn.disabled = chSyncRun.active || state.migrationActive || !state.rootHandle;
            if (migrateLayoutBtn) migrateLayoutBtn.disabled = disabled || !migrationRequired;
            if (selectAllCheckbox) selectAllCheckbox.disabled = disabled || state.filtered.length===0 || migrationRequired;
            syncSelectedBtn.disabled = disabled || migrationRequired || !state.rootHandle || state.selected.size===0;
            syncSelectedBtn.style.opacity = syncSelectedBtn.disabled ? '.50' : '1';
            syncSelectedBtn.textContent = migrationRequired
                ? chT('请先升级本地保存','Upgrade local save first')
                : !state.rootHandle
                    ? (state.savedRootHandle ? chT('继续使用保存位置后可同步','Continue the save location to sync') : chT('选择保存位置后可同步','Choose a save location to sync'))
                    : state.selected.size ? `${chT('同步选中','Sync selected')} ${state.selected.size}` : chT('请选择对话','Select conversations');
        };
        const renderList = () => {
            const listEl=$('conv-list'), statusEl=$('conv-status');
            listEl.innerHTML='';
            updateControls(); updateArchiveSummary();
            statusEl.style.background='transparent'; statusEl.style.color='#6b7280'; statusEl.style.padding='0'; statusEl.style.borderRadius='0';
            if(selectAllLabel) selectAllLabel.textContent = hasActiveFilters() ? chT('全选当前结果','Select current results') : chT('全选','Select all');
            if(state.loading && !state.list.length){statusEl.textContent=state.loadingMessage||chT('正在加载云端对话…','Loading cloud conversations…');if(selectAllCheckbox){selectAllCheckbox.checked=false;selectAllCheckbox.indeterminate=false;}return;}
            const matchedSelected = state.filtered.reduce((n,item)=>n+(state.selected.has(item.id)?1:0),0);
            if(selectAllCheckbox){selectAllCheckbox.checked=state.filtered.length>0&&matchedSelected===state.filtered.length;selectAllCheckbox.indeterminate=matchedSelected>0&&matchedSelected<state.filtered.length;}
            const providerTotal = state.remoteUniverse.length || state.list.length;
            const countParts=[`${chT('已选','Selected')} ${state.selected.size}`];
            if(state.filtered.length!==providerTotal) countParts.push(`${chT('当前','Current')} ${state.filtered.length} / ${chT('共','Total')} ${providerTotal}`);
            else countParts.push(`${chT('共','Total')} ${providerTotal}`);
            if(state.loading){
                statusEl.textContent = `${state.loadingMessage||chT('正在加载云端对话…','Loading cloud conversations…')}${providerTotal?` · ${chT('已获取','Loaded')} ${providerTotal} ${chT('条','items')}`:''} · ${countParts.join(' · ')}`;
            } else if (state.remoteLoadedNoticeUntil > Date.now()) {
                statusEl.textContent = `✓ ${chT('云端对话已加载','Cloud conversations loaded')} · ${chT('共','Total')} ${providerTotal} ${chT('条','items')}`;
                statusEl.style.background='#ecfdf5'; statusEl.style.color='#047857'; statusEl.style.padding='2px 8px'; statusEl.style.borderRadius='999px';
            } else {
                statusEl.textContent = countParts.join(' · ');
            }
            if(!state.filtered.length){const e=document.createElement('div');e.textContent=chT('没有匹配的对话。','No matching conversations.');e.style.cssText='color:#9ca3af;padding:12px 8px;';listEl.appendChild(e);return;}
            state.filtered.slice(0,state.visibleCount).forEach((item,index)=>{
                const row=document.createElement('label');
                row.style.cssText='display:grid;grid-template-columns:22px minmax(0,1fr) auto;gap:8px;align-items:center;padding:8px 9px;border:1px solid #e5e7eb;border-radius:7px;margin-bottom:6px;cursor:pointer;background:#fff;';
                const cb=document.createElement('input');cb.type='checkbox';cb.checked=state.selected.has(item.id);cb.disabled=state.loading||chSyncRun.active||state.migrationActive||Boolean(state.layoutState?.requiresMigration);
                cb.onclick=e=>{const checked=cb.checked;if(e.shiftKey && state.lastSelectedIndex!=null){const a=Math.min(state.lastSelectedIndex,index),b=Math.max(state.lastSelectedIndex,index);for(let i=a;i<=b;i++){const id=state.filtered[i]?.id;if(!id)continue;if(checked)state.selected.add(id);else state.selected.delete(id);}}else{if(checked)state.selected.add(item.id);else state.selected.delete(item.id);}state.lastSelectedIndex=index;renderList();};
                const content=document.createElement('div');content.style.minWidth='0';
                const title=document.createElement('div');title.textContent=item.title||'Untitled Conversation';title.style.cssText='font-size:13px;font-weight:650;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
                const meta=document.createElement('div');const time=formatTimestamp(state.timeField==='create'?item.create_time:item.update_time)||chT('未知','Unknown');const timeText=`${state.timeField==='create'?chT('创建','Created'):chT('更新','Updated')} ${time}`;meta.style.cssText='font-size:11px;color:#6b7280;margin-top:2px;display:flex;align-items:center;gap:5px;min-width:0;';
                if(item.projectTitle){const projectChip=document.createElement('span');projectChip.textContent=item.projectTitle;projectChip.title=item.projectTitle;projectChip.style.cssText='display:inline-block;max-width:180px;padding:1px 5px;border-radius:4px;background:#f3f4f6;color:#4b5563;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:0 1 auto;';meta.appendChild(projectChip);}
                const timeSpan=document.createElement('span');timeSpan.textContent=timeText;timeSpan.style.cssText='white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;';meta.appendChild(timeSpan);
                content.append(title,meta);row.append(cb,content);
                const badges=document.createElement('div');badges.style.cssText='display:flex;gap:5px;align-items:center;justify-content:flex-end;flex-wrap:wrap;';
                const s=state.syncStatusById.get(item.id);if(s){const [bg,fg]=statusColor(s);const badge=document.createElement('span');badge.textContent=statusLabel(s);badge.style.cssText=`font-size:11px;padding:3px 7px;border-radius:999px;background:${bg};color:${fg};white-space:nowrap;`;badges.appendChild(badge);}
                const attachmentInfo=attachmentInfoForItem(item);
                if(attachmentInfo.hasIssue){const attachmentBadge=document.createElement('span');attachmentBadge.textContent=attachmentInfo.missing>0?`${chT('附件','Attachments')} ${attachmentInfo.missing} ${chT('未归档','not archived')}`:chT('附件未完整','Attachments incomplete');attachmentBadge.title=chT('查看这个会话中未成功归档的附件','View attachments not successfully archived in this conversation');attachmentBadge.tabIndex=0;attachmentBadge.style.cssText='font-size:11px;padding:3px 7px;border-radius:999px;background:#fff7ed;color:#9a3412;white-space:nowrap;cursor:pointer;border:1px solid #fed7aa;';attachmentBadge.onclick=e=>{e.preventDefault();e.stopPropagation();showAttachmentDetails(item);};attachmentBadge.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();e.stopPropagation();showAttachmentDetails(item);}};badges.appendChild(attachmentBadge);}
                if(item.is_archived){const archiveBadge=document.createElement('span');archiveBadge.textContent=chT('已归档','Archived');archiveBadge.style.cssText='font-size:11px;padding:3px 7px;border-radius:999px;background:#fef3c7;color:#92400e;white-space:nowrap;';badges.appendChild(archiveBadge);}
                row.appendChild(badges);listEl.appendChild(row);
            });
            if(state.filtered.length>state.visibleCount){const more=document.createElement('button');more.textContent=`${chT('加载更多','Load more')} (${state.filtered.length-state.visibleCount})`;more.style.cssText='width:100%;padding:7px;border:1px solid #d1d5db;border-radius:6px;background:#fff;cursor:pointer;';more.onclick=()=>{state.visibleCount=Math.min(state.visibleCount+state.pageSize,state.filtered.length);renderList();};listEl.appendChild(more);}
        };
        const renderAll = () => { rebuildProjectOptions(); rebuildSyncOptions(); rebuildAttachmentOptions(); applyFilters(); updateTimeSummary(); renderList(); };

        const persistPolicy = () => {
            if (chSyncRun.active) { updateSettingsSummary(); return; }
            state.networkPolicy=chSaveNetworkPolicy({...state.networkPolicy,speedIndex:Number(speedLevelInput.value),batchSize:Number(batchSizeInput.value),batchPauseMinSec:Number(pauseMinInput.value),batchPauseMaxSec:Number(pauseMaxInput.value)});
            batchSizeInput.value=String(state.networkPolicy.batchSize);pauseMinInput.value=String(state.networkPolicy.batchPauseMinSec);pauseMaxInput.value=String(state.networkPolicy.batchPauseMaxSec);
            updateSettingsSummary();
        };
        const applySpeedPreset = () => {
            if (chSyncRun.active) { updateSettingsSummary(); return; }
            const speedIndex = Math.max(0, Math.min(CH_SPEED_LEVELS.length - 1, Number(speedLevelInput.value) || 0));
            const preset = CH_SPEED_LEVELS[speedIndex];
            state.networkPolicy=chSaveNetworkPolicy({...state.networkPolicy,speedIndex,batchSize:preset.batchSize,batchPauseMinSec:preset.pauseMinSec,batchPauseMaxSec:preset.pauseMaxSec});
            batchSizeInput.value=String(state.networkPolicy.batchSize);pauseMinInput.value=String(state.networkPolicy.batchPauseMinSec);pauseMaxInput.value=String(state.networkPolicy.batchPauseMaxSec);
            updateSettingsSummary();
        };
        const applyPreflightStatuses = plan => {
            state.syncStatusById.clear();
            for(const item of plan.items){let s=item.action;if(s==='VERIFY_CHANGED'||s==='VERIFY_RENAMED')s='VERIFY';state.syncStatusById.set(item.id,s);}
            state.lastPlan=plan;
        };
        const applyFinalStatuses = result => {
            const failedIds=new Set((result.sync?.failures||[]).map(x=>x.id));
            const committedIds=new Set((result.sync?.results||[]).map(x=>x.id));
            for(const item of result.verification.items||[]){
                if(!item.id||!item.finalAction)continue;
                if(failedIds.has(item.id)){state.syncStatusById.set(item.id,'ERROR');continue;}
                if(committedIds.has(item.id)){state.syncStatusById.set(item.id,'UNCHANGED');continue;}
                if(CH_FINAL_SYNC_ACTIONS.has(item.finalAction))continue;
                state.syncStatusById.set(item.id,item.finalAction);
            }
            state.lastPlan=result.plan;state.lastResult=result;
        };
        const ensureRoot = async () => {
            if(state.rootHandle)return state.rootHandle;
            throw new Error(chT('请先选择本地保存位置。','Choose a local save location first.'));
        };
        const chooseRoot = async () => {
            if(!window.showDirectoryPicker)throw new Error(chT('当前浏览器不支持选择本地目录。','Directory selection is unavailable in this browser.'));
            const handle=await window.showDirectoryPicker({mode:'readwrite'});
            state.rootHandle=handle; state.savedRootHandle=handle;
            await chDirectoryHandleSave(handle);
            updateArchiveSummary();
            return handle;
        };
        const restoreSavedRoot = async () => {
            const handle=await chDirectoryHandleLoad();
            if(!handle)return false;
            state.savedRootHandle=handle;
            const permission=await chDirectoryHandlePermission(handle,false);
            if(permission==='granted'){
                state.rootHandle=handle;
                state.layoutState=await chArchiveLayoutState(handle).catch(()=>null);
                updateArchiveSummary(); updateControls();
                if(state.list.length) await runPreflight(true);
                return true;
            }
            updateArchiveSummary(); updateControls();
            return false;
        };
        const decorateProjectKnowledge = (items, complete) => (items||[]).map(item=>({...item,__chProjectState:item.__chProjectState||((item.projectId||item.projectTitle)?'known':complete?'none':'unknown'),__chArchiveState:item.__chArchiveState||'known'}));
        const currentWorkspaceForRemote = () => state.mode==='team' ? state.workspaceId : null;
        const applyRemoteSnapshot = snapshot => {
            const list=decorateProjectKnowledge(snapshot?.list||[],snapshot?.complete===true);
            state.remoteUniverse=list;state.remoteUniverseComplete=snapshot?.complete===true;state.remoteUniverseNote=snapshot?.note||null;state.remoteCacheMeta={validatedAt:snapshot?.validatedAt||0,fullFetchedAt:snapshot?.fullFetchedAt||0,refreshMode:snapshot?.refreshMode||'cache'};state.remoteAppliedValidatedAt=Math.max(Number(state.remoteAppliedValidatedAt||0),Number(snapshot?.validatedAt||0));
            if(state.mode==='team'){state.list=list;return;}
            state.accountUniverse=list;state.accountUniverseComplete=state.remoteUniverseComplete;state.accountUniverseNote=state.remoteUniverseNote;state.accountLoadedAt=state.remoteCacheMeta.validatedAt||Date.now();
            state.list=state.mode==='project'?list.filter(item=>item.projectId||item.projectTitle):list;
        };
        const applyRemoteSnapshotSafely = async snapshot => {
            if(Number(snapshot?.validatedAt||0)<=Number(state.remoteAppliedValidatedAt||0))return false;
            if(chSyncRun.active){state.pendingRemoteSnapshot=snapshot;return false;}
            applyRemoteSnapshot(snapshot);renderAll();if(state.rootHandle)await runPreflight(true);return true;
        };
        const ensureTeamWorkspace = () => {
            if(state.mode!=='team')return;
            if(!state.workspaceId){const ids=detectAllWorkspaceIds();if(ids.length===0)throw new Error(chT('未检测到 Team Workspace ID，请先打开一个团队对话后再试。','No Team Workspace ID detected. Open a team conversation first.'));state.workspaceId=ids[0];}
        };
        const remoteProgressText = info => {
            if(!info)return chT('正在加载云端对话…','Loading cloud conversations…');
            if(info.message)return info.message;
            return chT('正在加载云端对话…','Loading cloud conversations…');
        };
        const announceRemoteLoaded = () => {
            state.remoteLoadedNoticeUntil = Date.now() + 1400;
            if (state.remoteLoadedNoticeTimer) clearTimeout(state.remoteLoadedNoticeTimer);
            renderList();
            state.remoteLoadedNoticeTimer = setTimeout(() => {
                state.remoteLoadedNoticeUntil = 0;
                state.remoteLoadedNoticeTimer = null;
                if (document.body.contains(overlay) && !state.loading) renderList();
            }, 1450);
        };
        const startRemoteRefresh = async (ws, options={}) => {
            if(state.remoteRefreshPromise)return state.remoteRefreshPromise;
            const generation=++state.remoteRefreshGeneration;
            const userProgress=options.onProgress;
            const userPartial=options.onPartial;
            const task=(async()=>{
                const snapshot=await chRefreshRemoteIndex(ws,{
                    ...options,
                    onProgress:info=>{
                        state.loadingMessage=remoteProgressText(info);
                        try{userProgress?.(info);}catch(_){}
                        if(state.loading)renderList();
                    },
                    onPartial:partial=>{
                        try{userPartial?.(partial);}catch(_){}
                        if(generation!==state.remoteRefreshGeneration||chSyncRun.active)return;
                        if(partial?.list?.length){applyRemoteSnapshot(partial);renderAll();}
                    }
                });
                if(generation!==state.remoteRefreshGeneration)return snapshot;
                return snapshot;
            })();
            state.remoteRefreshPromise=task;
            try{return await task;}finally{if(state.remoteRefreshPromise===task)state.remoteRefreshPromise=null;}
        };
        chSetNetworkStatusHook(info=>{
            if(chSyncRun.active||!state.loading||!info)return;
            const remaining=Number(info.remainingMs||0);
            const suffix=info.countdown&&remaining>0?` · ${chFormatRemainingDuration(remaining)}`:'';
            state.loadingMessage=`${info.primary||chT('网络等待','Network wait')}${suffix}${info.secondary?` · ${info.secondary}`:''}`;
            renderList();
        });
        const loadRemoteList = async (force=false, forceFull=false) => {
            state.loading=true;state.loadingMessage=chT('正在加载云端对话…','Loading cloud conversations…');state.syncStatusById.clear();state.lastPlan=null;renderList();
            try{
                ensureTeamWorkspace(); const ws=currentWorkspaceForRemote();
                if(!force){
                    const cached=await chRemoteCacheGet(ws);
                    // Complete or incomplete cache is useful for immediate display. Incomplete
                    // cache never proves LOCAL_ONLY and is always refreshed in the background.
                    if(cached&&Array.isArray(cached.list)&&cached.list.length){
                        applyRemoteSnapshot({...cached,refreshMode:cached.complete?'persistent-cache':'persistent-cache-incomplete'}); state.loading=false; renderAll(); if(state.rootHandle)await runPreflight(true);
                        void (async()=>{try{const fresh=await startRemoteRefresh(ws);const applied=await applyRemoteSnapshotSafely(fresh);if(applied)announceRemoteLoaded();}catch(err){console.warn('[ChatHarbor] background remote refresh failed',err);}})();
                        return;
                    }
                }
                const snapshot=await startRemoteRefresh(ws,{forceFull:Boolean(forceFull)}); applyRemoteSnapshot(snapshot); state.loading=false;state.loadingMessage=''; renderAll(); announceRemoteLoaded(); if(state.rootHandle)await runPreflight(true);
            }catch(err){state.loading=false;state.loadingMessage='';if(!state.remoteUniverse.length){state.list=[];state.filtered=[];state.remoteUniverse=[];}$('conv-status').textContent=`${chT('加载失败','Load failed')}: ${err.message}`;renderList();}
        };
        const ensureRemoteFreshForSync = async () => {
            ensureTeamWorkspace(); const ws=currentWorkspaceForRemote();
            if(state.remoteRefreshPromise){
                chSetProgress(chT('刷新云端对话','Refreshing remote index'),chT('等待正在进行的远端快速刷新完成…','Waiting for the active remote refresh…'),0);
                const snapshot=await state.remoteRefreshPromise;if(Number(snapshot?.validatedAt||0)>Number(state.remoteAppliedValidatedAt||0)){applyRemoteSnapshot(snapshot);renderAll();if(state.rootHandle)await runPreflight(true);}
            }
            const age=Date.now()-Number(state.remoteCacheMeta?.validatedAt||0);
            if(state.remoteUniverseComplete&&age>=0&&age<=CH_REMOTE_SYNC_FRESH_MS)return;
            chSetProgress(chT('刷新云端对话','Refreshing remote index'),chT('同步前确认最新列表；无变化时只检查最新窗口。','Confirming the latest remote index; stable heads stop early.'),0);
            const keep=new Set(state.selected); const snapshot=await startRemoteRefresh(ws); applyRemoteSnapshot(snapshot);
            state.selected.clear(); for(const id of keep)if(state.remoteUniverse.some(item=>item.id===id))state.selected.add(id); renderAll(); if(state.rootHandle)await runPreflight(true);
            if(!state.remoteUniverseComplete)throw new Error(chT('云端对话列表还没有加载完整。为避免漏同步，本轮不会写入，请稍后刷新重试。','The cloud conversation list is not fully loaded yet. To avoid missing conversations, this sync will not write; refresh and try again later.'));
        };
        const runPreflight = async (automatic=false, preserveResultReport=false) => {
            if(!state.rootHandle)return;
            const root=state.rootHandle;
            preflightBtn.disabled=true;
            try{
                state.layoutState=await chArchiveLayoutState(root);
                if(state.layoutState.requiresMigration){
                    state.lastPlan=null;state.localScan=null;state.syncStatusById.clear();state.syncStatus='all';state.attachmentIntegrity='all';
                    chSetProgress(chT('需要升级本地保存结构','Local save upgrade required'),`${chT('发现旧的保存结构','An older save structure was found')} · ${state.layoutState.total} ${chT('条记录','records')}`,100);
                    renderAll();return;
                }
                chSetProgress(automatic?chT('检查本地文件','Checking local files'):chT('重新检查','Checking again'),chT('正在检查本地文件…','Checking local files…'),0);
                const {localScan,plan}=await chRunPreflightPlanner({rootHandle:root,remoteList:state.remoteUniverse.length?state.remoteUniverse:state.list,selectedIds:null,remoteUniverseComplete:state.remoteUniverseComplete,remoteUniverseNote:state.remoteUniverseNote,includeAttachments:state.includeAttachments,retryFailedAttachments:state.retryFailedAttachments});
                if (!automatic) await chPersistOperationReport(root, 'LOCAL_PREFLIGHT', chPreflightReportText(plan));
                state.localScan=localScan;
                state.layoutState=await chArchiveLayoutState(root);
                applyPreflightStatuses(plan);renderAll();
                if (preserveResultReport && state.lastResult) {
                    state.lastResult.postSyncLocalSummary = { ...plan.summary };
                    state.lastResult.postSyncReconciledAt = new Date().toISOString();
                    chShowIntegratedSyncReport(state.lastResult);
                }
            }catch(err){if (!automatic) await chPersistOperationReport(root, 'LOCAL_CHECK_FAILURE', chSafeReportText(err.message || String(err))); console.error('[ChatHarbor] preflight failed',err);chSetProgress(chT('检查本地文件失败','Local scan failed'),err?.message||String(err),100);}finally{updateControls();}
        };
        const runLayoutMigration = async () => {
            if(!state.rootHandle || !state.layoutState?.requiresMigration || state.migrationActive)return;
            const ok = window.confirm(chT(
                '检测到旧的保存结构，需要升级后才能继续同步。升级只整理本地文件，不会重新下载对话，也不会删除未识别的文件。现在升级吗？',
                'An older save structure was found and must be upgraded before syncing. The upgrade only reorganizes local files; it will not re-download conversations or delete unrecognized files. Upgrade now?'
            ));
            if(!ok)return;
            state.migrationActive=true;updateControls();renderList();
            try{
                chSetProgress(chT('正在升级本地保存结构','Upgrading local save structure'),chT('只整理本地文件，不会下载对话','Reorganizing local files only; conversations will not be downloaded'),0);
                const result=await chMigrateArchiveLayoutV1ToV2(state.rootHandle,info=>{
                    const pct=info.total?Math.round((info.index/info.total)*100):0;
                    chSetProgress(chT('正在升级本地保存结构','Upgrading local save structure'),`${info.index}/${info.total} · ${String(info.title||info.id||'').slice(0,42)}`,pct);
                });
                state.migrationReport=result;
                state.layoutState=await chArchiveLayoutState(state.rootHandle);
                chRenderInlineReport(
                    chT('本地保存结构升级完成','Local save structure upgraded'),
                    [
                        `${chT('已整理','Reorganized')}: ${result.migrated}/${result.total}`,
                        `${chT('来源','Source')}: ${result.provider || CH_PROVIDER}`,
                        `${chT('保存结构已升级','Save structure upgraded')}`,
                        `${chT('需要注意','Needs attention')}: ${(result.cleanupWarnings||[]).length}`,
                        chT('未重新下载任何会话。','No conversation was re-downloaded.')
                    ],
                    JSON.stringify(result,null,2),
                    (result.cleanupWarnings||[]).length?'warn':'success'
                );
                await runPreflight(true);
            }catch(err){
                console.error('[ChatHarbor] layout migration failed',err);
                state.layoutState=await chArchiveLayoutState(state.rootHandle).catch(()=>state.layoutState);
                chSetProgress(chT('本地保存结构升级未完成','Local save upgrade incomplete'),err?.message||String(err),100);
                chRenderInlineReport(chT('本地保存结构升级未完成','Local save upgrade incomplete'),[err?.message||String(err),chT('已完成的逐会话提交保持有效；下次可继续升级。','Completed per-conversation commits remain valid; migration can be resumed.')],err?.stack||err?.message||String(err),'error');
            }finally{
                state.migrationActive=false;updateArchiveSummary();updateControls();renderList();
            }
        };
        const runSync = async () => {
            const root=await ensureRoot();
            if(state.layoutState?.requiresMigration){chSetProgress(chT('需要升级本地保存结构','Local save upgrade required'),chT('请先完成升级，再开始同步。','Finish the upgrade before syncing.'),100);return;}
            try{
                await ensureRemoteFreshForSync();
                const selectedIds=new Set(state.selected);
                if(selectedIds.size===0)return;
                chBeginControlledRun(state.networkPolicy);
                state.runSettings={includeAttachments:Boolean(state.includeAttachments),retryFailedAttachments:Boolean(state.retryFailedAttachments),networkPolicy:{...chSyncRun.policy}};
                const launcher=getExportButton(); launcher.classList.add('gre-busy'); const launcherPill=document.getElementById('gre-fab-status'); if(launcherPill)launcherPill.classList.remove('gre-visible');
                renderList();chSetProgress(chT('同步','Directory sync'),`${chT('正在准备同步…','Preparing sync…')} · ${chNetworkPolicySummary(chSyncRun.policy)}`,0);
                const remote=state.remoteUniverse.length?state.remoteUniverse:state.list;
                const result=await chRunIntegratedDirectorySync({rootHandle:root,remoteList:remote,selectedIds,workspaceId:state.workspaceId,includeAttachments:state.runSettings.includeAttachments,retryFailedAttachments:state.runSettings.retryFailedAttachments,remoteUniverseComplete:state.remoteUniverseComplete,remoteUniverseNote:state.remoteUniverseNote,networkPolicy:chSyncRun.policy,onItemClassified:(item)=>{if(item.id&&item.finalAction==='ERROR'){state.syncStatusById.set(item.id,'ERROR');renderList();}},onItemCommitted:(item)=>{if(item.id&&item.finalAction)state.syncStatusById.set(item.id,'UNCHANGED');renderList();},onItemFailed:(item)=>{if(item.id){state.syncStatusById.set(item.id,'ERROR');renderList();}}});
                applyFinalStatuses(result);renderAll();
            }catch(err){if(state.rootHandle) await chPersistOperationReport(state.rootHandle, 'SYNC_FAILURE', chSafeReportText(err.message || String(err))); if(chIsCancellation(err))chSetProgress(chT('同步已取消','Sync cancelled'),chT('已在安全边界停止；已提交会话保留。','Stopped at a safe boundary; committed conversations were kept.'),100);else{console.error('[ChatHarbor] sync failed',err);chSetProgress(chT('同步失败','Sync failed'),err?.message||String(err),100);}}finally{const launcher=getExportButton();launcher.classList.remove('gre-busy','gre-progress');const launcherPill=document.getElementById('gre-fab-status');if(launcherPill)launcherPill.classList.remove('gre-visible');fabScheduleCollapse(launcher);chEndControlledRun();state.runSettings=null;const deferred=state.pendingRemoteSnapshot;state.pendingRemoteSnapshot=null;if(deferred){applyRemoteSnapshot(deferred);renderAll();if(state.rootHandle)await runPreflight(true);}else if(state.rootHandle){await runPreflight(true,true);}else{renderList();} if(state.lastResult?.reportPending){await chPersistOperationReport(state.rootHandle, 'SYNC_COMPLETION', chIntegratedSyncReportText(state.lastResult) + '\nSelected IDs: ' + state.lastResult.reportSelectedIds.join(', ') + '\nRun failures: ' + JSON.stringify(state.lastResult.sync.failures || [])); state.lastResult.reportPending=false;}}
        };

        searchInput.oninput=e=>{state.query=e.target.value||'';applyFilters();renderList();};
        spaceSelect.onchange=async e=>{const next=e.target.value;state.projectFilter='all';state.syncStatus='all';state.mode=next;state.workspaceId=null;await loadRemoteList(false);};
        projectSelect.onchange=e=>{state.projectFilter=e.target.value;applyFilters();renderList();};
        archivedSelect.onchange=e=>{state.archived=e.target.value;applyFilters();renderList();};
        syncStatusSelect.onchange=e=>{state.syncStatus=e.target.value;applyFilters();renderList();};
        attachmentIntegritySelect.onchange=e=>{state.attachmentIntegrity=e.target.value;applyFilters();renderList();};
        timeFieldSelect.onchange=e=>{state.timeField=e.target.value;applyFilters();renderList();};
        timeRangeSelect.onchange=e=>{state.timeRange=e.target.value;updateTimeSummary();applyFilters();renderList();};
        sortSelect.onchange=e=>{state.sort=e.target.value;applyFilters();renderList();};
        startDateInput.onchange=e=>{state.startDate=e.target.value||'';applyFilters();renderList();};
        endDateInput.onchange=e=>{state.endDate=e.target.value||'';applyFilters();renderList();};
        includeAttachmentsInput.onchange=async e=>{if(chSyncRun.active){e.target.checked=Boolean(state.runSettings?.includeAttachments);updateSettingsSummary();return;}state.includeAttachments=e.target.checked;if(!state.includeAttachments)state.retryFailedAttachments=false;updateSettingsSummary();if(state.rootHandle)await runPreflight(true);};
        retryFailedAttachmentsInput.onchange=async e=>{if(chSyncRun.active){e.target.checked=Boolean(state.runSettings?.retryFailedAttachments);updateSettingsSummary();return;}state.retryFailedAttachments=Boolean(e.target.checked)&&state.includeAttachments;updateSettingsSummary();if(state.rootHandle)await runPreflight(true);};
        selectAllCheckbox.onchange=()=>{const allSelected=state.filtered.length>0&&state.filtered.every(item=>state.selected.has(item.id));if(allSelected){state.filtered.forEach(item=>state.selected.delete(item.id));}else{state.filtered.forEach(item=>state.selected.add(item.id));}renderList();};
        refreshBtn.title=chT('更新云端对话列表。','Update the cloud conversation list.');
        preflightBtn.title=chT('重新检查当前保存位置。','Check the current save location again.');refreshBtn.onclick=async(e)=>{const keep=new Set(state.selected);await loadRemoteList(true,Boolean(e?.shiftKey));state.selected.clear();for(const id of keep)if(state.list.some(item=>item.id===id))state.selected.add(id);renderList();};
        closeBtn.onclick=closeDialog;
        chooseDirBtn.onclick=async()=>{try{
            state.lastPlan=null;
            if(!state.rootHandle && state.savedRootHandle){
                const permission=await chDirectoryHandlePermission(state.savedRootHandle,true);
                if(permission==='granted') state.rootHandle=state.savedRootHandle;
                else return;
            } else {
                await chooseRoot();
            }
            state.layoutState=await chArchiveLayoutState(state.rootHandle).catch(()=>null);
            await runPreflight(true);
        }catch(err){if(err?.name!=='AbortError')chSetProgress(chT('选择保存位置失败','Could not choose save location'),err?.message||String(err),null);}};
        preflightBtn.onclick=()=>runPreflight(false);
        const historyBtn = document.createElement('button');
        historyBtn.textContent=chT('历史报告','Report history');
        historyBtn.style.cssText=preflightBtn.style.cssText;
        historyBtn.onclick=()=>state.rootHandle ? chOpenReportHistory(state.rootHandle) : window.alert(chT('请先选择保存位置。','Choose a save location first.'));
        const reportStatus = document.createElement('div'); reportStatus.id='ch-report-storage-status';
        reportStatus.style.cssText='font-size:11px;overflow-wrap:anywhere;margin-top:5px';
        preflightBtn.parentElement.after(historyBtn,reportStatus);
        migrateLayoutBtn.onclick=runLayoutMigration;
        syncSelectedBtn.onclick=runSync;
        speedLevelInput.onchange=applySpeedPreset;
        [batchSizeInput,pauseMinInput,pauseMaxInput].forEach(el=>el.onchange=persistPolicy);
        pauseSyncBtn.onclick=()=>{if(!chSyncRun.active)return;if(chSyncRun.paused)chResumeRun();else chRequestPause();};
        cancelSyncBtn.onclick=()=>{if(!chSyncRun.active)return;chRequestCancel('USER_CANCELLED');chSetProgress(chT('正在取消同步','Cancelling sync'),chT('不会开始新的详情请求或新的会话事务；当前原子事务会先完成。','No new detail fetch or conversation transaction will start; the current atomic transaction will finish first.'),null);};
        overlay.onclick=e=>{if(e.target===overlay)closeDialog();};
        document.addEventListener('keydown',function esc(ev){if(ev.key==='Escape'&&document.body.contains(overlay)&&!chSyncRun.active&&!state.migrationActive){document.removeEventListener('keydown',esc);closeDialog();}});
        chUpdateRunControlUi();updateTimeSummary();updateSettingsSummary();restoreSavedRoot();loadRemoteList();
    }

    /**
     * [重构] 多步骤、用户主导的导出对话框
     */
    function showExportDialog(options = {}) {
        if (document.getElementById('export-dialog-overlay')) return;

        const overlay = document.createElement('div');
        overlay.id = 'export-dialog-overlay';
        Object.assign(overlay.style, {
            position: 'fixed', top: '0', left: '0', width: '100%', height: '100%',
            backgroundColor: 'rgba(0, 0, 0, 0.5)', zIndex: '99998',
            display: 'flex', alignItems: 'center', justifyContent: 'center'
        });

        const dialog = document.createElement('div');
        dialog.id = 'export-dialog';
        Object.assign(dialog.style, {
            background: '#fff', padding: '24px', borderRadius: '12px',
            boxShadow: '0 5px 15px rgba(0,0,0,.3)', width: '450px',
            fontFamily: 'sans-serif', color: '#333', boxSizing: 'border-box'
        });

        const closeDialog = () => document.body.removeChild(overlay);

        let pendingTeamAction = null;
        let includeAttachments = Boolean(options.includeAttachments);
        const renderStep = (step, action = null) => {
            pendingTeamAction = action;
            let html = '';
            switch (step) {
                case 'team': {
                    const detectedIds = detectAllWorkspaceIds();
                    html = `<h2 style="margin-top:0; margin-bottom: 20px; font-size: 18px;">导出团队空间</h2>`;

                    if (detectedIds.length > 1) {
                        html += `<div style="background: #eef2ff; border: 1px solid #818cf8; border-radius: 8px; padding: 12px; margin-bottom: 20px;">
                                     <p style="margin: 0 0 12px 0; font-weight: bold; color: #4338ca;">🔎 检测到多个 Workspace，请选择一个:</p>
                                     <div id="workspace-id-list">`;
                        detectedIds.forEach((id, index) => {
                            html += `<label style="display: block; margin-bottom: 8px; padding: 8px; border-radius: 6px; cursor: pointer; border: 1px solid #ddd; background: #fff;">
                                         <input type="radio" name="workspace_id" value="${id}" ${index === 0 ? 'checked' : ''}>
                                         <code style="margin-left: 8px; font-family: monospace; color: #555;">${id}</code>
                                      </label>`;
                        });
                        html += `</div></div>`;
                    } else if (detectedIds.length === 1) {
                        html += `<div style="background: #f0fdf4; border: 1px solid #4ade80; border-radius: 8px; padding: 12px; margin-bottom: 20px;">
                                     <p style="margin: 0 0 8px 0; font-weight: bold; color: #166534;">✅ 已自动检测到 Workspace ID:</p>
                                     <code id="workspace-id-code" style="background: #e0e7ff; padding: 4px 8px; border-radius: 4px; font-family: monospace; color: #4338ca; word-break: break-all;">${detectedIds[0]}</code>
                                   </div>`;
                    } else {
                        html += `<div style="background: #fffbeb; border: 1px solid #facc15; border-radius: 8px; padding: 12px; margin-bottom: 20px;">
                                     <p style="margin: 0; color: #92400e;">⚠️ 未能自动检测到 Workspace ID。</p>
                                     <p style="margin: 8px 0 0 0; font-size: 12px; color: #92400e;">请尝试刷新页面或打开一个团队对话，或在下方手动输入。</p>
                                   </div>
                                   <label for="team-id-input" style="display: block; margin-bottom: 8px; font-weight: bold;">手动输入 Team Workspace ID:</label>
                                   <input type="text" id="team-id-input" placeholder="粘贴您的 Workspace ID (ws-...)" style="width: 100%; padding: 8px; border-radius: 6px; border: 1px solid #ccc; box-sizing: border-box;">`;
                    }

                    let actionButtons = '';
                    if (pendingTeamAction === 'all') {
                        actionButtons = `<button id="start-team-export-btn" style="padding: 10px 16px; border: none; border-radius: 8px; background: #10a37f; color: #fff; cursor: pointer; font-weight: bold;">导出全部 (ZIP)</button>`;
                    } else if (pendingTeamAction === 'select') {
                        actionButtons = `<button id="start-team-picker-btn" style="padding: 10px 16px; border: 1px solid #ccc; border-radius: 8px; background: #fff; cursor: pointer;">选择对话 / 同步</button>`;
                    } else {
                        actionButtons = `<button id="start-team-export-btn" style="padding: 10px 16px; border: none; border-radius: 8px; background: #10a37f; color: #fff; cursor: pointer; font-weight: bold;">导出全部 (ZIP)</button>
                                     <button id="start-team-picker-btn" style="padding: 10px 16px; border: 1px solid #ccc; border-radius: 8px; background: #fff; cursor: pointer;">选择对话 / 同步</button>`;
                    }

                    html += `<div style="display: flex; justify-content: space-between; align-items: center; margin-top: 24px;">
                                 <button id="back-btn" style="padding: 10px 16px; border: 1px solid #ccc; border-radius: 8px; background: #fff; cursor: pointer;">返回</button>
                                 <div style="display: flex; gap: 8px;">
                                     ${actionButtons}
                                 </div>
                               </div>`;
                    break;
                }

                case 'initial':
                default:
                    html = `<h2 style="margin-top:0; margin-bottom: 20px; font-size: 18px;">ChatHarbor｜选择空间</h2>
                                <div style="display: flex; flex-direction: column; gap: 16px;">
                                    <div style="padding: 16px; border: 1px solid #ccc; border-radius: 8px; background: #f9fafb;">
                                        <strong style="font-size: 16px;">个人空间</strong>
                                        <p style="margin: 4px 0 12px 0; color: #666;">导出您个人账户下的对话。</p>
                                        <div style="display: flex; gap: 8px;">
                                            <button id="select-personal-btn" style="padding: 8px 12px; border: none; border-radius: 6px; background: #10a37f; color: #fff; cursor: pointer; font-weight: bold;">导出全部</button>
                                            <button id="select-personal-picker-btn" style="padding: 8px 12px; border: 1px solid #ccc; border-radius: 6px; background: #fff; cursor: pointer;">选择对话 / 同步</button>
                                        </div>
                                    </div>
                                    <div style="padding: 16px; border: 1px solid #ccc; border-radius: 8px; background: #f9fafb;">
                                        <strong style="font-size: 16px;">项目空间</strong>
                                        <p style="margin: 4px 0 12px 0; color: #666;">导出项目空间下的对话，将按项目自动分组。</p>
                                        <div style="display: flex; gap: 8px;">
                                            <button id="select-project-btn" style="padding: 8px 12px; border: none; border-radius: 6px; background: #10a37f; color: #fff; cursor: pointer; font-weight: bold;">导出全部</button>
                                            <button id="select-project-picker-btn" style="padding: 8px 12px; border: 1px solid #ccc; border-radius: 6px; background: #fff; cursor: pointer;">选择对话 / 同步</button>
                                        </div>
                                    </div>
                                    <div style="padding: 16px; border: 1px solid #ccc; border-radius: 8px; background: #f9fafb;">
                                        <strong style="font-size: 16px;">团队空间</strong>
                                        <p style="margin: 4px 0 12px 0; color: #666;">导出团队空间下的对话，将自动检测ID。</p>
                                        <div style="display: flex; gap: 8px;">
                                            <button id="select-team-btn" style="padding: 8px 12px; border: none; border-radius: 6px; background: #10a37f; color: #fff; cursor: pointer; font-weight: bold;">导出全部</button>
                                            <button id="select-team-picker-btn" style="padding: 8px 12px; border: 1px solid #ccc; border-radius: 6px; background: #fff; cursor: pointer;">选择对话 / 同步</button>
                                        </div>
                                    </div>
                                </div>
                                <label style="display: flex; align-items: flex-start; gap: 8px; margin-top: 16px; padding: 12px; border: 1px solid #d1d5db; border-radius: 8px; background: #f9fafb; cursor: pointer;">
                                    <input id="include-attachments" type="checkbox" ${includeAttachments ? 'checked' : ''} style="margin-top: 2px;">
                                    <span>
                                        <strong style="display: block; font-size: 13px;">同时下载上传和生成的附件</strong>
                                        <span style="display: block; margin-top: 2px; color: #666; font-size: 12px;">默认关闭；开启后处理时间与本地占用可能明显增加。</span>
                                    </span>
                                </label>
                                <div style="display: flex; justify-content: flex-end; margin-top: 24px;">
                                    <button id="cancel-btn" style="padding: 10px 16px; border: 1px solid #ccc; border-radius: 8px; background: #fff; cursor: pointer;">取消</button>
                                </div>`;
                    break;
            }
            dialog.innerHTML = html;
            attachListeners(step);
        };

        const attachListeners = (step) => {
            if (step === 'initial') {
                const includeAttachmentsInput = document.getElementById('include-attachments');
                includeAttachmentsInput.onchange = (event) => {
                    includeAttachments = event.target.checked;
                };
                document.getElementById('select-personal-btn').onclick = () => {
                    closeDialog();
                    startExportProcess('personal', null, includeAttachments);
                };
                document.getElementById('select-personal-picker-btn').onclick = () => {
                    closeDialog();
                    showConversationPicker({ mode: 'personal', workspaceId: null, includeAttachments });
                };
                document.getElementById('select-project-btn').onclick = () => {
                    closeDialog();
                    startProjectSpaceExportProcess(null, includeAttachments);
                };
                document.getElementById('select-project-picker-btn').onclick = () => {
                    closeDialog();
                    showConversationPicker({ mode: 'project', workspaceId: null, includeAttachments });
                };
                const startTeamFlow = (action) => {
                    const detectedIds = detectAllWorkspaceIds();
                    if (detectedIds.length === 1) {
                        const workspaceId = detectedIds[0];
                        closeDialog();
                        if (action === 'all') {
                            startExportProcess('team', workspaceId, includeAttachments);
                        } else {
                            showConversationPicker({ mode: 'team', workspaceId, includeAttachments });
                        }
                        return;
                    }
                    renderStep('team', action);
                };
                document.getElementById('select-team-btn').onclick = () => startTeamFlow('all');
                document.getElementById('select-team-picker-btn').onclick = () => startTeamFlow('select');
                document.getElementById('cancel-btn').onclick = closeDialog;
            } else if (step === 'team') {
                document.getElementById('back-btn').onclick = () => renderStep('initial');
                const resolveWorkspaceId = () => {
                    let workspaceId = '';
                    const radioChecked = document.querySelector('input[name="workspace_id"]:checked');
                    const codeEl = document.getElementById('workspace-id-code');
                    const inputEl = document.getElementById('team-id-input');

                    if (radioChecked) {
                        workspaceId = radioChecked.value;
                    } else if (codeEl) {
                        workspaceId = codeEl.textContent;
                    } else if (inputEl) {
                        workspaceId = inputEl.value.trim();
                    }

                    if (!workspaceId) {
                        alert('请选择或输入一个有效的 Team Workspace ID！');
                        return;
                    }
                    return workspaceId;
                };
                const exportAllBtn = document.getElementById('start-team-export-btn');
                const pickerBtn = document.getElementById('start-team-picker-btn');
                if (exportAllBtn) exportAllBtn.onclick = () => {
                    const workspaceId = resolveWorkspaceId();
                    if (!workspaceId) return;
                    closeDialog();
                    startExportProcess('team', workspaceId, includeAttachments);
                };
                if (pickerBtn) pickerBtn.onclick = () => {
                    const workspaceId = resolveWorkspaceId();
                    if (!workspaceId) return;
                    closeDialog();
                    showConversationPicker({ mode: 'team', workspaceId, includeAttachments });
                };
            }
        };

        overlay.appendChild(dialog);
        document.body.appendChild(overlay);
        overlay.onclick = (e) => { if (e.target === overlay) closeDialog(); };
        renderStep('initial');
    }

    // --- 脚本启动 ---
    // ChatHarbor 悬浮入口：页面加载后即可见（点击打开 / 拖动移动 / 贴边半隐藏 / 右键重置）
    if (document.body) {
        initFab();
    } else {
        document.addEventListener('DOMContentLoaded', initFab);
    }

    const previousRuntimeVersion = document.documentElement.getAttribute('data-chatharbor-version');
    if (previousRuntimeVersion !== ATTACHMENT_EXPORT_VERSION) {
        document.getElementById('export-dialog-overlay')?.remove();
    }
    document.documentElement.setAttribute('data-chatharbor-ready', '1');
    document.documentElement.setAttribute('data-chatharbor-version', ATTACHMENT_EXPORT_VERSION);
    console.info(`[ChatHarbor] runtime v${ATTACHMENT_EXPORT_VERSION} ready`);

})();
