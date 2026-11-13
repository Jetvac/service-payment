import fs from "node:fs";
import path from "node:path";
import { Router, type Request, type Response } from "express";
import type { AppContext } from "./context";
import { id, nowIso } from "./domain";
import { badRequest, currentUser, forbidden, HttpError, notFound, param, pageResult, readPage, requireAdmin, route, sendError, text } from "./http";
import type { AppData, User, WallComment, WallFile, WallPost, WallTag } from "./types";

const legacyWallFilesDir = path.resolve(process.env.APP_DATA_DIR || path.join(process.cwd(), "data"), "wall-files");
const maxWallFileSize = Math.max(1, Number(process.env.MAX_UPLOAD_MB ?? 50)) * 1024 * 1024;

/** Types a browser may render inline from our origin. SVG is excluded: it can run script. */
const INLINE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "application/pdf", "video/mp4", "video/webm"]);

export function wallFileUrl(fileId: string) {
  return `/api/wall/files/${encodeURIComponent(fileId)}/download`;
}

function publicWallFile(file: WallFile) {
  return { ...file, url: wallFileUrl(file.id) };
}

function safeFileName(value: string) {
  const normalized = value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim();
  return normalized.slice(0, 180) || "file";
}

function decodeHeaderValue(value: unknown, fallback = "") {
  const raw = String(value ?? fallback);
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function postComments(data: AppData, postId: string) {
  return data.wallComments.filter((comment) => comment.postId === postId);
}

/** Every file a post refers to: preview, attachments, inline links, comment files. */
function wallPostFileIds(data: AppData, post: WallPost) {
  const ids = new Set<string>();
  if (post.previewFileId) ids.add(post.previewFileId);
  for (const fileId of post.fileIds) ids.add(fileId);
  const comments = postComments(data, post.id);
  for (const comment of comments) for (const fileId of comment.fileIds) ids.add(fileId);
  for (const file of data.wallFiles) {
    const url = wallFileUrl(file.id);
    if (post.content.includes(url) || comments.some((comment) => comment.content.includes(url))) ids.add(file.id);
  }
  return ids;
}

function isWallFileUsed(data: AppData, fileId: string) {
  return data.wallPosts.some((post) => wallPostFileIds(data, post).has(fileId));
}

/** Removes candidate files that nothing references any more; returns their ids. */
function removeUnusedFiles(data: AppData, candidateIds: Iterable<string>) {
  const candidates = new Set(Array.from(candidateIds).filter(Boolean));
  const unused = data.wallFiles.filter((file) => candidates.has(file.id) && !isWallFileUsed(data, file.id));
  if (!unused.length) return [];
  const unusedIds = new Set(unused.map((file) => file.id));
  data.wallFiles = data.wallFiles.filter((file) => !unusedIds.has(file.id));
  for (const post of data.wallPosts) {
    post.fileIds = post.fileIds.filter((fileId) => !unusedIds.has(fileId));
    if (post.previewFileId && unusedIds.has(post.previewFileId)) post.previewFileId = null;
  }
  return unused;
}

function wallPostFlags(post: WallPost, tags: WallTag[]) {
  const postTags = tags.filter((tag) => post.tagIds.includes(tag.id));
  return { pinned: postTags.some((tag) => tag.pinned), archived: postTags.some((tag) => tag.archived) };
}

function publicWallPost(data: AppData, post: WallPost) {
  return {
    ...post,
    commentCount: data.wallComments.filter((comment) => comment.postId === post.id && !comment.deletedAt).length
  };
}

function wallListData(data: AppData, query: Record<string, unknown>) {
  const { offset, limit } = readPage(query, 20, 80);
  const search = String(query.search ?? "").trim().toLowerCase();
  const serviceId = String(query.serviceId ?? "");
  const tagId = String(query.tagId ?? "");
  const archived = String(query.archive ?? "false") === "true";

  const posts = data.wallPosts
    .map((post) => ({ post, flags: wallPostFlags(post, data.wallTags) }))
    .filter(({ flags }) => flags.archived === archived)
    .filter(({ post }) => !serviceId || post.serviceId === serviceId)
    .filter(({ post }) => !tagId || post.tagIds.includes(tagId))
    .filter(({ post }) => !search || post.title.toLowerCase().includes(search) || post.content.toLowerCase().includes(search))
    .sort((a, b) => Number(b.flags.pinned) - Number(a.flags.pinned) || b.post.updatedAt.localeCompare(a.post.updatedAt))
    .map(({ post }) => publicWallPost(data, post));

  return {
    posts: pageResult(posts, offset, limit),
    tags: data.wallTags,
    files: data.wallFiles.map(publicWallFile)
  };
}

function sortedComments(data: AppData, postId: string) {
  return postComments(data, postId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function stringList(value: unknown) {
  return Array.isArray(value) ? Array.from(new Set(value.map((item) => String(item)).filter(Boolean))) : [];
}

function readPostInput(data: AppData, body: Record<string, unknown>, existing?: WallPost) {
  const serviceId = body.serviceId ? String(body.serviceId) : null;
  if (serviceId && !data.services.some((service) => service.id === serviceId)) throw badRequest("Сервис не найден");
  const knownFile = (fileId: string) => data.wallFiles.some((file) => file.id === fileId);

  // `undefined` keeps the current preview, `null`/"" removes it.
  const previewInput = body.previewFileId === undefined ? existing?.previewFileId ?? null : body.previewFileId ? String(body.previewFileId) : null;

  return {
    title: text(body.title ?? existing?.title, 160) || "Без названия",
    previewFileId: previewInput && knownFile(previewInput) ? previewInput : null,
    content: String(body.content ?? existing?.content ?? "").slice(0, 200_000),
    serviceId,
    tagIds: stringList(body.tagIds).filter((tagId) => data.wallTags.some((tag) => tag.id === tagId)),
    fileIds: stringList(body.fileIds).filter(knownFile)
  };
}

function readCommentInput(data: AppData, postId: string, body: Record<string, unknown>) {
  if (!data.wallPosts.some((post) => post.id === postId)) throw notFound("Пост не найден");
  const parentId = body.parentId ? String(body.parentId) : null;
  if (parentId && !data.wallComments.some((comment) => comment.id === parentId && comment.postId === postId && !comment.deletedAt)) {
    throw badRequest("Комментарий для ответа не найден");
  }
  const fileIds = stringList(body.fileIds).filter((fileId) => data.wallFiles.some((file) => file.id === fileId));
  const content = String(body.content ?? "").trim().slice(0, 20_000);
  if (!content && !fileIds.length) throw badRequest("Комментарий пустой");
  return { parentId, content, fileIds };
}

function readTagInput(data: AppData, body: Record<string, unknown>, existing?: WallTag) {
  const name = text(body.name ?? existing?.name, 48);
  if (!name) throw badRequest("Название тега обязательно");
  if (data.wallTags.some((tag) => tag.id !== existing?.id && tag.name.toLowerCase() === name.toLowerCase())) {
    throw badRequest("Такой тег уже есть");
  }
  const color = String(body.color ?? existing?.color ?? "#7aa8ff");
  return {
    name,
    color: /^#[0-9a-f]{6}$/i.test(color) ? color : "#7aa8ff",
    pinned: body.pinned === undefined ? Boolean(existing?.pinned) : Boolean(body.pinned),
    archived: body.archived === undefined ? Boolean(existing?.archived) : Boolean(body.archived)
  };
}

const canManagePost = (actor: User, post: WallPost) => actor.botAdmin || post.authorId === actor.id;
const canManageComment = (actor: User, comment: WallComment) => actor.botAdmin || comment.authorId === actor.id;

/** Drops soft-deleted comments that no longer have any replies under them. */
function pruneDeletedComments(data: AppData, postId: string) {
  let removed = true;
  while (removed) {
    removed = false;
    for (const comment of data.wallComments) {
      if (comment.postId !== postId || !comment.deletedAt) continue;
      if (!data.wallComments.some((item) => item.parentId === comment.id)) {
        data.wallComments = data.wallComments.filter((item) => item.id !== comment.id);
        removed = true;
        break;
      }
    }
  }
}

function setDownloadHeaders(res: Response, file: WallFile, size: number) {
  const mimeType = file.mimeType || "application/octet-stream";
  const inline = INLINE_MIME_TYPES.has(mimeType.toLowerCase());
  const asciiName = safeFileName(file.originalName).replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "");
  res.setHeader("Content-Type", inline ? mimeType : "application/octet-stream");
  res.setHeader("Content-Length", String(size));
  res.setHeader(
    "Content-Disposition",
    `${inline ? "inline" : "attachment"}; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(file.originalName)}`
  );
  // Uploaded files come from users: never let one run script on our origin.
  res.setHeader("Content-Security-Policy", "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox");
  res.setHeader("Cache-Control", "private, max-age=3600");
}

export function wallRoutes({ store, broadcast }: AppContext) {
  const router = Router();
  const listResponse = (req: Request) => wallListData(store.read(), req.query as Record<string, unknown>);

  const commentsChanged = (postId: string) => {
    const comments = sortedComments(store.read(), postId);
    broadcast({ type: "wall-comments-changed", postId, comments });
    return comments;
  };

  /** Deletes blobs for files that a write removed from the state. */
  const writeAndCollect = (mutator: (data: AppData) => void) => {
    const before = new Set(store.read().wallFiles.map((file) => file.id));
    store.write(mutator);
    const after = new Set(store.read().wallFiles.map((file) => file.id));
    for (const fileId of before) {
      if (after.has(fileId)) continue;
      store.deleteWallFileBlob(fileId);
    }
  };

  router.get("/wall", route((req) => listResponse(req)));

  router.get(
    "/wall/posts/:id",
    route((req) => {
      const data = store.read();
      const post = data.wallPosts.find((item) => item.id === param(req, "id"));
      if (!post) throw notFound("Пост не найден");
      return publicWallPost(data, post);
    })
  );

  router.post(
    "/wall/posts/:id/view",
    route((req) => {
      store.write((data) => {
        const post = data.wallPosts.find((item) => item.id === param(req, "id"));
        if (!post) throw notFound("Пост не найден");
        post.views += 1;
      });
      const data = store.read();
      return publicWallPost(data, data.wallPosts.find((item) => item.id === param(req, "id"))!);
    })
  );

  router.post(
    "/wall/posts",
    route((req) => {
      const actor = currentUser(req);
      store.write((data) => {
        const createdAt = nowIso();
        data.wallPosts.unshift({ id: id("wpost"), ...readPostInput(data, req.body), authorId: actor.id, views: 0, createdAt, updatedAt: createdAt });
      });
      return listResponse(req);
    })
  );

  router.put(
    "/wall/posts/:id",
    route((req) => {
      const actor = currentUser(req);
      writeAndCollect((data) => {
        const post = data.wallPosts.find((item) => item.id === param(req, "id"));
        if (!post) throw notFound("Пост не найден");
        if (!canManagePost(actor, post)) throw forbidden("Нет прав на изменение поста");
        const previousFileIds = wallPostFileIds(data, post);
        Object.assign(post, readPostInput(data, req.body, post), { updatedAt: nowIso() });
        removeUnusedFiles(data, previousFileIds);
      });
      return listResponse(req);
    })
  );

  router.delete(
    "/wall/posts/:id",
    route((req) => {
      const actor = currentUser(req);
      writeAndCollect((data) => {
        const post = data.wallPosts.find((item) => item.id === param(req, "id"));
        if (!post) throw notFound("Пост не найден");
        if (!canManagePost(actor, post)) throw forbidden("Нет прав на удаление поста");
        const previousFileIds = wallPostFileIds(data, post);
        data.wallPosts = data.wallPosts.filter((item) => item.id !== post.id);
        data.wallComments = data.wallComments.filter((comment) => comment.postId !== post.id);
        removeUnusedFiles(data, previousFileIds);
      });
      return listResponse(req);
    })
  );

  router.get(
    "/wall/posts/:id/comments",
    route((req) => {
      const data = store.read();
      if (!data.wallPosts.some((post) => post.id === param(req, "id"))) throw notFound("Пост не найден");
      return sortedComments(data, param(req, "id"));
    })
  );

  router.post(
    "/wall/posts/:id/comments",
    route((req) => {
      const actor = currentUser(req);
      const postId = param(req, "id");
      store.write((data) => {
        const input = readCommentInput(data, postId, req.body);
        const createdAt = nowIso();
        data.wallComments.push({ id: id("wcom"), postId, ...input, authorId: actor.id, deletedAt: null, createdAt, updatedAt: createdAt });
      });
      return commentsChanged(postId);
    })
  );

  router.put(
    "/wall/posts/:postId/comments/:commentId",
    route((req) => {
      const actor = currentUser(req);
      const postId = param(req, "postId");
      writeAndCollect((data) => {
        const comment = data.wallComments.find((item) => item.id === param(req, "commentId") && item.postId === postId);
        if (!comment) throw notFound("Комментарий не найден");
        if (comment.deletedAt) throw badRequest("Удалённый комментарий нельзя редактировать");
        if (comment.authorId !== actor.id) throw forbidden("Редактировать можно только свои комментарии");
        const previousFileIds = new Set(comment.fileIds);
        const input = readCommentInput(data, postId, { ...req.body, parentId: comment.parentId });
        comment.content = input.content;
        comment.fileIds = input.fileIds;
        comment.updatedAt = nowIso();
        removeUnusedFiles(data, previousFileIds);
      });
      return commentsChanged(postId);
    })
  );

  router.delete(
    "/wall/posts/:postId/comments/:commentId",
    route((req) => {
      const actor = currentUser(req);
      const postId = param(req, "postId");
      writeAndCollect((data) => {
        const comment = data.wallComments.find((item) => item.id === param(req, "commentId") && item.postId === postId);
        if (!comment) throw notFound("Комментарий не найден");
        if (comment.deletedAt) throw badRequest("Комментарий уже удалён");
        if (!canManageComment(actor, comment)) throw forbidden("Нет прав на удаление комментария");

        const fileIds = new Set(comment.fileIds);
        if (data.wallComments.some((item) => item.parentId === comment.id)) {
          // Keep the node so the replies under it stay in place.
          comment.content = "Комментарий удалён";
          comment.fileIds = [];
          comment.deletedAt = nowIso();
          comment.updatedAt = comment.deletedAt;
        } else {
          data.wallComments = data.wallComments.filter((item) => item.id !== comment.id);
          pruneDeletedComments(data, postId);
        }
        removeUnusedFiles(data, fileIds);
      });
      return commentsChanged(postId);
    })
  );

  router.post(
    "/wall/tags",
    route((req) => {
      requireAdmin(req);
      store.write((data) => {
        data.wallTags.push({ id: id("wtag"), ...readTagInput(data, req.body), createdAt: nowIso() });
      });
      return listResponse(req);
    })
  );

  router.put(
    "/wall/tags/:id",
    route((req) => {
      requireAdmin(req);
      store.write((data) => {
        const tag = data.wallTags.find((item) => item.id === param(req, "id"));
        if (!tag) throw notFound("Тег не найден");
        Object.assign(tag, readTagInput(data, req.body, tag));
      });
      return listResponse(req);
    })
  );

  router.delete(
    "/wall/tags/:id",
    route((req) => {
      requireAdmin(req);
      store.write((data) => {
        data.wallTags = data.wallTags.filter((tag) => tag.id !== param(req, "id"));
        for (const post of data.wallPosts) post.tagIds = post.tagIds.filter((tagId) => tagId !== param(req, "id"));
      });
      return listResponse(req);
    })
  );

  router.post("/wall/files", async (req, res) => {
    try {
      const actor = currentUser(req);
      const limitMb = Math.round(maxWallFileSize / 1024 / 1024);
      if (Number(req.header("content-length") ?? 0) > maxWallFileSize) throw new HttpError(413, `Файл больше ${limitMb} МБ`);

      const chunks: Buffer[] = [];
      let received = 0;
      await new Promise<void>((resolve, reject) => {
        req.on("data", (chunk: Buffer) => {
          received += chunk.length;
          if (received > maxWallFileSize) {
            req.destroy();
            reject(new HttpError(413, `Файл больше ${limitMb} МБ`));
            return;
          }
          chunks.push(chunk);
        });
        req.on("end", resolve);
        req.on("error", reject);
      });
      if (!received) throw badRequest("Файл пустой");

      const fileId = id("wfile");
      const originalName = safeFileName(decodeHeaderValue(req.header("x-file-name"), "file"));
      const file: WallFile = {
        id: fileId,
        originalName,
        storageName: "",
        mimeType: text(req.header("content-type"), 120) || "application/octet-stream",
        size: received,
        url: wallFileUrl(fileId),
        uploadedBy: actor.id,
        createdAt: nowIso()
      };
      store.saveWallFile(file, Buffer.concat(chunks));
      res.json({ ok: true, payload: publicWallFile(file) });
    } catch (error) {
      sendError(res, error);
    }
  });

  /** Removes the caller's uploads that ended up unused (e.g. a cancelled draft). */
  router.post(
    "/wall/files/cleanup",
    route((req) => {
      const actor = currentUser(req);
      const candidates = stringList(req.body?.fileIds);
      writeAndCollect((data) => {
        const own = candidates.filter((fileId) => actor.botAdmin || data.wallFiles.find((file) => file.id === fileId)?.uploadedBy === actor.id);
        removeUnusedFiles(data, own);
      });
      return listResponse(req);
    })
  );

  router.delete(
    "/wall/files/:id",
    route((req) => {
      const actor = currentUser(req);
      let storageName = "";
      store.write((data) => {
        const file = data.wallFiles.find((item) => item.id === param(req, "id"));
        if (!file) throw notFound("Файл не найден");
        if (!actor.botAdmin && file.uploadedBy !== actor.id) throw forbidden("Нет прав на удаление файла");
        storageName = file.storageName;
        data.wallFiles = data.wallFiles.filter((item) => item.id !== file.id);
        for (const post of data.wallPosts) {
          post.fileIds = post.fileIds.filter((fileId) => fileId !== file.id);
          if (post.previewFileId === file.id) post.previewFileId = null;
        }
        for (const comment of data.wallComments) comment.fileIds = comment.fileIds.filter((fileId) => fileId !== file.id);
      });
      store.deleteWallFileBlob(param(req, "id"));
      if (storageName) fs.rmSync(path.join(legacyWallFilesDir, path.basename(storageName)), { force: true });
      return listResponse(req);
    })
  );

  return router;
}

/**
 * Public download (images are embedded with plain <img> tags, which cannot
 * send the auth header). File ids are random and unguessable.
 */
export function wallDownloadRoute({ store }: AppContext) {
  return (req: Request, res: Response) => {
    try {
      const file = store.read().wallFiles.find((item) => item.id === param(req, "id"));
      if (!file) throw notFound("Файл не найден");
      let content = store.readWallFile(file.id);
      if (!content && file.storageName) {
        const legacyPath = path.join(legacyWallFilesDir, path.basename(file.storageName));
        if (fs.existsSync(legacyPath)) content = fs.readFileSync(legacyPath);
      }
      if (!content) throw notFound("Файл отсутствует в базе данных");
      setDownloadHeaders(res, file, content.length);
      res.send(content);
    } catch (error) {
      sendError(res, error);
    }
  };
}
