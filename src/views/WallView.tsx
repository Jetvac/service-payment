import {
  Archive,
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  Eye,
  FileText,
  ImagePlus,
  Link2,
  MessageCircle,
  Newspaper,
  Paperclip,
  Pencil,
  Pin,
  Plus,
  Search,
  Send,
  Tag,
  Trash2,
  Upload,
  X
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type ReactNode } from "react";
import { api, authToken, errorMessage } from "../api";
import { useApp, useResource } from "../app-context";
import { classNames, dateTime, fileSize } from "../format";
import type { User, WallComment, WallFile, WallListData, WallPost, WallTag } from "../types";
import { Avatar, Badge, Card, copyText, Empty, Field, Modal, PageHeader, Pagination, Spinner, Switch, useDebounced, useFeedback } from "../ui";

const PAGE = 20;
const emptyWall: WallListData = { posts: { rows: [], total: 0, offset: 0, limit: PAGE, hasMore: false }, tags: [], files: [] };

/* ------------------------------------------------------------------ helpers */

async function uploadWallFile(file: File) {
  return api<WallFile>("/api/wall/files", {
    raw: file,
    headers: { "Content-Type": file.type || "application/octet-stream", "x-file-name": encodeURIComponent(file.name) }
  });
}

function cleanupFiles(fileIds: string[]) {
  if (fileIds.length) api("/api/wall/files/cleanup", { body: { fileIds } }).catch(() => undefined);
}

/** Only our own file links and http(s) URLs are rendered; anything else becomes text. */
function safeUrl(url: string) {
  const value = url.trim();
  if (value.startsWith("/api/wall/files/")) return value;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

/** Renders the small markup the editor produces: ![alt|width](url) and [text](url). */
function RichText({ content }: { content: string }) {
  const pattern = /!\[([^\]|]*)(?:\|(\d{2,4}))?\]\(([^)\s]+)\)|\[([^\]]+)\]\(([^)\s]+)\)/g;
  return (
    <div className="rich-text">
      {content.split("\n").map((line, lineIndex) => {
        const parts: ReactNode[] = [];
        let cursor = 0;
        for (const match of line.matchAll(pattern)) {
          const index = match.index ?? 0;
          if (index > cursor) parts.push(line.slice(cursor, index));
          const url = safeUrl(match[3] ?? match[5] ?? "");
          if (!url) parts.push(match[0]);
          else if (match[3]) {
            const width = Math.min(1200, Math.max(120, Number(match[2] ?? 720)));
            parts.push(<img key={index} src={url} alt={match[1]} loading="lazy" style={{ width, maxWidth: "100%" }} />);
          } else {
            const internal = url.startsWith("/api/");
            parts.push(
              <a key={index} href={url} {...(internal ? { download: "" } : { target: "_blank", rel: "noreferrer noopener" })}>
                {match[4]}
              </a>
            );
          }
          cursor = index + match[0].length;
        }
        if (cursor < line.length) parts.push(line.slice(cursor));
        return <p key={lineIndex}>{parts.length ? parts : " "}</p>;
      })}
    </div>
  );
}

const isImage = (file: WallFile) => /^image\/(png|jpe?g|gif|webp|avif)$/i.test(file.mimeType);
const flags = (post: WallPost, tags: WallTag[]) => {
  const postTags = tags.filter((tag) => post.tagIds.includes(tag.id));
  return { postTags, pinned: postTags.some((tag) => tag.pinned), archived: postTags.some((tag) => tag.archived) };
};

function TagChip({ tag, selected, onClick }: { tag: WallTag; selected?: boolean; onClick?: () => void }) {
  const style = { "--tag": tag.color } as CSSProperties;
  return onClick ? (
    <button type="button" className={classNames("tag", "tag-button", selected && "selected")} style={style} aria-pressed={selected} onClick={onClick}>
      {tag.name}
    </button>
  ) : (
    <span className="tag" style={style}>
      {tag.name}
    </span>
  );
}

function Attachment({ file }: { file: WallFile }) {
  if (isImage(file)) {
    return (
      <a className="attachment-image" href={file.url} target="_blank" rel="noreferrer" title={file.originalName}>
        <img src={file.url} alt={file.originalName} loading="lazy" />
      </a>
    );
  }
  return (
    <a className="attachment-file" href={file.url} download>
      <Paperclip size={15} />
      <span>{file.originalName}</span>
      <small>{fileSize(file.size)}</small>
    </a>
  );
}

/* --------------------------------------------------------------------- view */

export function WallView({ postId }: { postId?: string }) {
  const { state, isAdmin, navigate } = useApp();
  const [search, setSearch] = useState("");
  const debouncedSearch = useDebounced(search.trim(), 300);
  const [tagId, setTagId] = useState("");
  const [serviceId, setServiceId] = useState("");
  const [archive, setArchive] = useState(false);
  const [offset, setOffset] = useState(0);
  const [editing, setEditing] = useState<WallPost | "new" | null>(null);
  const [tagsOpen, setTagsOpen] = useState(false);

  useEffect(() => setOffset(0), [debouncedSearch, tagId, serviceId, archive]);

  const query = new URLSearchParams({ offset: String(offset), limit: String(PAGE), archive: String(archive) });
  if (debouncedSearch) query.set("search", debouncedSearch);
  if (tagId) query.set("tagId", tagId);
  if (serviceId) query.set("serviceId", serviceId);
  const wall = useResource((signal) => api<WallListData>(`/api/wall?${query.toString()}`, { signal }), [query.toString()], emptyWall);

  // One realtime connection while the wall is open: keeps comment counters fresh.
  const [liveComments, setLiveComments] = useState<{ postId: string; comments: WallComment[] } | null>(null);
  useEffect(() => {
    const token = authToken.get();
    if (!token) return;
    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    let socket: WebSocket | null = null;
    let retry: number | undefined;
    let closed = false;
    const connect = () => {
      socket = new WebSocket(`${protocol}://${window.location.host}/api/realtime?token=${encodeURIComponent(token)}`);
      socket.onmessage = (event) => {
        try {
          const message = JSON.parse(String(event.data)) as { type?: string; postId?: string; comments?: WallComment[] };
          if (message.type !== "wall-comments-changed" || !message.postId || !Array.isArray(message.comments)) return;
          const count = message.comments.filter((comment) => !comment.deletedAt).length;
          wall.setData((current) => ({
            ...current,
            posts: { ...current.posts, rows: current.posts.rows.map((post) => (post.id === message.postId ? { ...post, commentCount: count } : post)) }
          }));
          setLiveComments({ postId: message.postId, comments: message.comments });
        } catch {
          // Ignore malformed realtime messages.
        }
      };
      socket.onclose = (event) => {
        if (!closed && event.code !== 1008) retry = window.setTimeout(connect, 5_000);
      };
    };
    connect();
    return () => {
      closed = true;
      window.clearTimeout(retry);
      socket?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const editor = editing && (
    <PostEditor
      post={editing === "new" ? undefined : editing}
      tags={wall.data.tags}
      files={wall.data.files}
      onClose={() => setEditing(null)}
      onSaved={(next) => {
        wall.setData(next);
        setEditing(null);
      }}
    />
  );

  if (postId) {
    return (
      <div className="page">
        <PostDetail
          postId={postId}
          tags={wall.data.tags}
          files={wall.data.files}
          liveComments={liveComments?.postId === postId ? liveComments.comments : null}
          onEdit={(post) => setEditing(post)}
          onDeleted={(next) => {
            wall.setData(next);
            navigate({ view: "wall" });
          }}
          onFilesChanged={wall.reload}
        />
        {editor}
      </div>
    );
  }

  return (
    <div className="page">
      <PageHeader
        title="Стена"
        subtitle="Инструкции, новости и файлы для участников"
        actions={
          <>
            {isAdmin && (
              <button className="btn btn-ghost" type="button" onClick={() => setTagsOpen(true)}>
                <Tag size={16} />
                Теги
              </button>
            )}
            <button className="btn btn-primary" type="button" onClick={() => setEditing("new")}>
              <Plus size={17} />
              Новый пост
            </button>
          </>
        }
      />

      <Card flush>
        <div className="card-toolbar">
          <div className="input-icon grow">
            <Search size={16} />
            <input type="search" placeholder="Поиск по заголовку и тексту" aria-label="Поиск по стене" value={search} onChange={(event) => setSearch(event.target.value)} />
          </div>
          <div className="filters">
            <select aria-label="Тег" value={tagId} onChange={(event) => setTagId(event.target.value)}>
              <option value="">Все теги</option>
              {wall.data.tags.map((tag) => (
                <option key={tag.id} value={tag.id}>
                  {tag.name}
                </option>
              ))}
            </select>
            <select aria-label="Сервис" value={serviceId} onChange={(event) => setServiceId(event.target.value)}>
              <option value="">Все сервисы</option>
              {state.services.map((service) => (
                <option key={service.id} value={service.id}>
                  {service.name}
                </option>
              ))}
            </select>
            <button className={classNames("btn btn-ghost", archive && "is-active")} type="button" aria-pressed={archive} onClick={() => setArchive((value) => !value)}>
              <Archive size={16} />
              Архив
            </button>
            {wall.loading && <Spinner />}
          </div>
        </div>

        {wall.data.posts.rows.length ? (
          <ul className="post-list">
            {wall.data.posts.rows.map((post) => (
              <PostRow key={post.id} post={post} tags={wall.data.tags} files={wall.data.files} />
            ))}
          </ul>
        ) : (
          !wall.loading && (
            <Empty
              icon={Newspaper}
              title={archive ? "В архиве пусто" : debouncedSearch || tagId || serviceId ? "Ничего не найдено" : "Постов пока нет"}
              text={!archive && !debouncedSearch && !tagId && !serviceId ? "Напишите первую инструкцию по подключению." : undefined}
            />
          )
        )}
        <Pagination page={wall.data.posts} onChange={setOffset} />
      </Card>

      {editor}
      {tagsOpen && <TagsModal tags={wall.data.tags} onChanged={(next) => wall.setData(next)} onClose={() => setTagsOpen(false)} />}
    </div>
  );
}

function PostRow({ post, tags, files }: { post: WallPost; tags: WallTag[]; files: WallFile[] }) {
  const { userById, serviceById } = useApp();
  const { postTags, pinned, archived } = flags(post, tags);
  const preview = files.find((file) => file.id === post.previewFileId) ?? files.find((file) => post.fileIds.includes(file.id) && isImage(file));
  const excerpt = post.content.replace(/!?\[([^\]|]*)(\|\d+)?\]\([^)]*\)/g, "$1").replace(/\s+/g, " ").trim().slice(0, 180);

  return (
    <li>
      <a className={classNames("post-row", pinned && "pinned")} href={`#/wall/${post.id}`}>
        <span className="post-thumb">{preview ? <img src={preview.url} alt="" loading="lazy" /> : <FileText size={22} />}</span>
        <span className="post-row-main">
          <span className="post-row-title">
            {pinned && <Pin size={14} className="text-accent" aria-label="Закреплён" />}
            <strong>{post.title}</strong>
            {archived && <Badge tone="muted">архив</Badge>}
          </span>
          {excerpt && <span className="post-excerpt">{excerpt}</span>}
          <span className="post-meta">
            <span>{userById(post.authorId)?.name ?? "Автор"}</span>
            <span>{dateTime(post.updatedAt)}</span>
            {post.serviceId && <span>{serviceById(post.serviceId)?.name}</span>}
            <span>
              <Eye size={13} /> {post.views}
            </span>
            <span>
              <MessageCircle size={13} /> {post.commentCount ?? 0}
            </span>
          </span>
        </span>
        {postTags.length > 0 && (
          <span className="post-tags">
            {postTags.slice(0, 3).map((tag) => (
              <TagChip key={tag.id} tag={tag} />
            ))}
          </span>
        )}
      </a>
    </li>
  );
}

/* ------------------------------------------------------------------- detail */

function PostDetail({
  postId,
  tags,
  files,
  liveComments,
  onEdit,
  onDeleted,
  onFilesChanged
}: {
  postId: string;
  tags: WallTag[];
  files: WallFile[];
  liveComments: WallComment[] | null;
  onEdit: (post: WallPost) => void;
  onDeleted: (next: WallListData) => void;
  onFilesChanged: () => void;
}) {
  const { me, isAdmin, navigate, userById, serviceById } = useApp();
  const { toast, confirm } = useFeedback();
  const [post, setPost] = useState<WallPost | null>(null);
  const [comments, setComments] = useState<WallComment[]>([]);
  const [missing, setMissing] = useState(false);
  const viewed = useRef("");

  const { revision } = useApp();
  useEffect(() => {
    const controller = new AbortController();
    setMissing(false);
    const countView = viewed.current !== postId;
    viewed.current = postId;
    Promise.all([
      countView ? api<WallPost>(`/api/wall/posts/${postId}/view`, { body: {}, signal: controller.signal }) : api<WallPost>(`/api/wall/posts/${postId}`, { signal: controller.signal }),
      api<WallComment[]>(`/api/wall/posts/${postId}/comments`, { signal: controller.signal })
    ])
      .then(([nextPost, nextComments]) => {
        setPost(nextPost);
        setComments(nextComments);
      })
      .catch((error) => {
        if ((error as Error).name === "AbortError") return;
        setMissing(true);
      });
    return () => controller.abort();
  }, [postId, revision]);

  useEffect(() => {
    if (liveComments) setComments(liveComments);
  }, [liveComments]);

  if (missing) {
    return (
      <Card>
        <Empty
          icon={Newspaper}
          title="Пост не найден"
          text="Возможно, его удалили."
          action={
            <button className="btn btn-ghost" type="button" onClick={() => navigate({ view: "wall" })}>
              <ArrowLeft size={16} /> К стене
            </button>
          }
        />
      </Card>
    );
  }
  if (!post) return <Spinner label="Загрузка поста" />;

  const { postTags, pinned, archived } = flags(post, tags);
  const attachments = files.filter((file) => post.fileIds.includes(file.id));
  const author = userById(post.authorId);
  const canManage = isAdmin || post.authorId === me.id;

  const remove = async () => {
    const answer = await confirm({ title: `Удалить «${post.title}»?`, message: "Пост, комментарии и файлы, которые больше нигде не используются, будут удалены.", confirmLabel: "Удалить", tone: "danger" });
    if (answer === null) return;
    try {
      onDeleted(await api<WallListData>(`/api/wall/posts/${post.id}`, { method: "DELETE" }));
      toast("Пост удалён");
    } catch (error) {
      toast(errorMessage(error), "error");
    }
  };

  return (
    <article className="post-detail">
      <div className="post-detail-nav">
        <a className="btn btn-ghost btn-sm" href="#/wall">
          <ArrowLeft size={16} />
          Стена
        </a>
        <div className="toolbar">
          <button
            className="icon-btn"
            type="button"
            title="Скопировать ссылку"
            aria-label="Скопировать ссылку"
            onClick={async () => toast((await copyText(`${window.location.origin}${window.location.pathname}#/wall/${post.id}`)) ? "Ссылка скопирована" : "Не удалось скопировать", "info")}
          >
            <Link2 size={17} />
          </button>
          {canManage && (
            <>
              <button className="btn btn-ghost btn-sm" type="button" onClick={() => onEdit(post)}>
                <Pencil size={15} />
                Изменить
              </button>
              <button className="icon-btn danger" type="button" title="Удалить пост" aria-label="Удалить пост" onClick={remove}>
                <Trash2 size={17} />
              </button>
            </>
          )}
        </div>
      </div>

      <Card>
        <header className="post-header">
          <h1>
            {pinned && <Pin size={18} className="text-accent" />}
            {post.title}
            {archived && <Badge tone="muted">архив</Badge>}
          </h1>
          <div className="post-meta">
            {author && (
              <span className="cell-person">
                <Avatar user={author} size="sm" />
                {author.name}
              </span>
            )}
            <span>{dateTime(post.updatedAt)}</span>
            <span>{serviceById(post.serviceId)?.name ?? "Для всех"}</span>
            <span>
              <Eye size={13} /> {post.views}
            </span>
          </div>
          {postTags.length > 0 && (
            <div className="post-tags">
              {postTags.map((tag) => (
                <TagChip key={tag.id} tag={tag} />
              ))}
            </div>
          )}
        </header>
        {post.content.trim() ? <RichText content={post.content} /> : <p className="muted">Текста нет</p>}
        {attachments.length > 0 && (
          <div className="attachments">
            <h3>Файлы</h3>
            <div className="attachment-grid">
              {attachments.map((file) => (
                <Attachment key={file.id} file={file} />
              ))}
            </div>
          </div>
        )}
      </Card>

      <Card title="Комментарии" subtitle={comments.filter((comment) => !comment.deletedAt).length ? undefined : "Пока никто не написал"}>
        <Composer
          placeholder="Написать комментарий"
          files={files}
          onFilesChanged={onFilesChanged}
          onSubmit={async (content, fileIds) => setComments(await api<WallComment[]>(`/api/wall/posts/${post.id}/comments`, { body: { content, fileIds } }))}
        />
        <CommentTree postId={post.id} comments={comments} files={files} onChange={setComments} onFilesChanged={onFilesChanged} />
      </Card>
    </article>
  );
}

/* ----------------------------------------------------------------- comments */

function Composer({
  placeholder,
  files,
  initial,
  submitLabel = "Отправить",
  compact = false,
  onSubmit,
  onCancel,
  onFilesChanged
}: {
  placeholder: string;
  files: WallFile[];
  initial?: { content: string; fileIds: string[] };
  submitLabel?: string;
  compact?: boolean;
  onSubmit: (content: string, fileIds: string[]) => Promise<void>;
  onCancel?: () => void;
  onFilesChanged: () => void;
}) {
  const { me } = useApp();
  const { toast } = useFeedback();
  const [content, setContent] = useState(initial?.content ?? "");
  const [fileIds, setFileIds] = useState<string[]>(initial?.fileIds ?? []);
  const [uploaded, setUploaded] = useState<WallFile[]>([]);
  const [busy, setBusy] = useState(false);
  const known = useMemo(() => [...uploaded, ...files.filter((file) => !uploaded.some((item) => item.id === file.id))], [files, uploaded]);
  const attached = known.filter((file) => fileIds.includes(file.id));
  const empty = !content.trim() && !fileIds.length;

  const upload = async (list: FileList | null) => {
    if (!list?.length) return;
    setBusy(true);
    try {
      for (const file of Array.from(list)) {
        const result = await uploadWallFile(file);
        setUploaded((current) => [result, ...current]);
        setFileIds((current) => [...current, result.id]);
      }
    } catch (error) {
      toast(errorMessage(error, "Не удалось загрузить файл"), "error");
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    if (empty || busy) return;
    setBusy(true);
    try {
      await onSubmit(content.trim(), fileIds);
      setContent("");
      setFileIds([]);
      setUploaded([]);
      onFilesChanged();
    } catch (error) {
      toast(errorMessage(error, "Не удалось отправить"), "error");
    } finally {
      setBusy(false);
    }
  };

  const cancel = () => {
    cleanupFiles(uploaded.map((file) => file.id));
    onCancel?.();
  };

  return (
    <div className={classNames("composer", compact && "compact")}>
      {!compact && <Avatar user={me} />}
      <div className="composer-body">
        <textarea
          rows={compact ? 2 : 3}
          placeholder={placeholder}
          value={content}
          aria-label={placeholder}
          onChange={(event) => setContent(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) void submit();
          }}
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault();
            void upload(event.dataTransfer.files);
          }}
        />
        {attached.length > 0 && (
          <div className="file-chips">
            {attached.map((file) => (
              <span key={file.id} className="file-chip">
                <Paperclip size={13} />
                {file.originalName}
                <button type="button" aria-label={`Убрать ${file.originalName}`} onClick={() => setFileIds((current) => current.filter((item) => item !== file.id))}>
                  <X size={13} />
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="composer-actions">
          <label className="btn btn-ghost btn-sm">
            <Upload size={15} />
            Файл
            <input hidden multiple type="file" disabled={busy} onChange={(event) => upload(event.target.files)} />
          </label>
          <span className="grow muted small">Ctrl+Enter — отправить</span>
          {onCancel && (
            <button className="btn btn-ghost btn-sm" type="button" disabled={busy} onClick={cancel}>
              Отмена
            </button>
          )}
          <button className="btn btn-primary btn-sm" type="button" disabled={empty || busy} onClick={submit}>
            {busy ? <Spinner /> : <Send size={15} />}
            {submitLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function CommentTree({
  postId,
  comments,
  files,
  onChange,
  onFilesChanged
}: {
  postId: string;
  comments: WallComment[];
  files: WallFile[];
  onChange: (comments: WallComment[]) => void;
  onFilesChanged: () => void;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const children = useMemo(() => {
    const map = new Map<string, WallComment[]>();
    for (const comment of comments) map.set(comment.parentId ?? "root", [...(map.get(comment.parentId ?? "root") ?? []), comment]);
    return map;
  }, [comments]);

  const toggle = (set: Set<string>, id: string) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  };

  const branch = (parentId: string, depth: number): ReactNode => {
    const items = children.get(parentId) ?? [];
    const visible = expanded.has(parentId) || items.length <= 4 ? items : items.slice(0, 3);
    return (
      <ul className={classNames("comments", depth > 0 && "nested")}>
        {visible.map((comment) => {
          const replies = children.get(comment.id)?.length ?? 0;
          return (
            <li key={comment.id}>
              <CommentItem postId={postId} comment={comment} files={files} onChange={onChange} onFilesChanged={onFilesChanged} />
              {replies > 0 && (
                <button className="link-btn reply-toggle" type="button" onClick={() => setCollapsed((current) => toggle(current, comment.id))}>
                  {collapsed.has(comment.id) ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                  {collapsed.has(comment.id) ? `Показать ответы (${replies})` : "Свернуть ответы"}
                </button>
              )}
              {replies > 0 && !collapsed.has(comment.id) && branch(comment.id, depth + 1)}
            </li>
          );
        })}
        {visible.length < items.length && (
          <li>
            <button className="link-btn" type="button" onClick={() => setExpanded((current) => new Set(current).add(parentId))}>
              Показать ещё {items.length - visible.length}
            </button>
          </li>
        )}
      </ul>
    );
  };

  return comments.length ? branch("root", 0) : null;
}

function CommentItem({
  postId,
  comment,
  files,
  onChange,
  onFilesChanged
}: {
  postId: string;
  comment: WallComment;
  files: WallFile[];
  onChange: (comments: WallComment[]) => void;
  onFilesChanged: () => void;
}) {
  const { me, isAdmin, userById } = useApp();
  const { toast, confirm } = useFeedback();
  const [mode, setMode] = useState<"view" | "reply" | "edit">("view");
  const author: Pick<User, "name" | "avatarUrl"> = userById(comment.authorId) ?? { name: "Участник", avatarUrl: "" };
  const deleted = Boolean(comment.deletedAt);
  const attached = deleted ? [] : files.filter((file) => comment.fileIds.includes(file.id));

  const remove = async () => {
    const answer = await confirm({ title: "Удалить комментарий?", message: "Если на него уже ответили, останется пометка «Комментарий удалён».", confirmLabel: "Удалить", tone: "danger" });
    if (answer === null) return;
    try {
      onChange(await api<WallComment[]>(`/api/wall/posts/${postId}/comments/${comment.id}`, { method: "DELETE" }));
      onFilesChanged();
    } catch (error) {
      toast(errorMessage(error), "error");
    }
  };

  return (
    <div className={classNames("comment", deleted && "deleted")}>
      <Avatar user={author} size="sm" />
      <div className="comment-body">
        <div className="comment-meta">
          <strong>{author.name}</strong>
          <span>{dateTime(comment.createdAt)}</span>
          {!deleted && comment.updatedAt !== comment.createdAt && <span>изменён</span>}
        </div>
        {mode === "edit" ? (
          <Composer
            compact
            placeholder="Комментарий"
            files={files}
            initial={{ content: comment.content, fileIds: comment.fileIds }}
            submitLabel="Сохранить"
            onCancel={() => setMode("view")}
            onFilesChanged={onFilesChanged}
            onSubmit={async (content, fileIds) => {
              onChange(await api<WallComment[]>(`/api/wall/posts/${postId}/comments/${comment.id}`, { method: "PUT", body: { content, fileIds } }));
              setMode("view");
            }}
          />
        ) : (
          <>
            {comment.content && <p className="comment-text">{comment.content}</p>}
            {attached.length > 0 && (
              <div className="attachment-grid small">
                {attached.map((file) => (
                  <Attachment key={file.id} file={file} />
                ))}
              </div>
            )}
            {!deleted && (
              <div className="comment-actions">
                <button className="link-btn" type="button" onClick={() => setMode(mode === "reply" ? "view" : "reply")}>
                  Ответить
                </button>
                {comment.authorId === me.id && (
                  <button className="link-btn" type="button" onClick={() => setMode("edit")}>
                    Изменить
                  </button>
                )}
                {(comment.authorId === me.id || isAdmin) && (
                  <button className="link-btn danger" type="button" onClick={remove}>
                    Удалить
                  </button>
                )}
              </div>
            )}
          </>
        )}
        {mode === "reply" && (
          <Composer
            compact
            placeholder={`Ответ для ${author.name}`}
            files={files}
            onCancel={() => setMode("view")}
            onFilesChanged={onFilesChanged}
            onSubmit={async (content, fileIds) => {
              onChange(await api<WallComment[]>(`/api/wall/posts/${postId}/comments`, { body: { content, fileIds, parentId: comment.id } }));
              setMode("view");
            }}
          />
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------- editor */

type Draft = { title: string; content: string; serviceId: string; tagIds: string[]; fileIds: string[]; previewFileId: string | null };

function PostEditor({
  post,
  tags,
  files,
  onClose,
  onSaved
}: {
  post?: WallPost;
  tags: WallTag[];
  files: WallFile[];
  onClose: () => void;
  onSaved: (next: WallListData) => void;
}) {
  const { state } = useApp();
  const { toast } = useFeedback();
  const textRef = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState<Draft>({
    title: post?.title ?? "",
    content: post?.content ?? "",
    serviceId: post?.serviceId ?? "",
    tagIds: post?.tagIds ?? [],
    fileIds: post?.fileIds ?? [],
    previewFileId: post?.previewFileId ?? null
  });
  const [uploaded, setUploaded] = useState<WallFile[]>([]);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const known = [...uploaded, ...files.filter((file) => !uploaded.some((item) => item.id === file.id))];
  const draftFiles = known.filter((file) => draft.fileIds.includes(file.id));
  const preview = known.find((file) => file.id === draft.previewFileId);

  const insert = (text: string) => {
    const element = textRef.current;
    const start = element?.selectionStart ?? draft.content.length;
    const end = element?.selectionEnd ?? draft.content.length;
    setDraft((current) => ({ ...current, content: `${current.content.slice(0, start)}${text}${current.content.slice(end)}` }));
    window.setTimeout(() => {
      element?.focus();
      element?.setSelectionRange(start + text.length, start + text.length);
    });
  };

  const upload = async (list: FileList | File[] | null, asPreview = false) => {
    const items = Array.from(list ?? []);
    if (!items.length) return;
    setBusy(true);
    try {
      for (const file of items) {
        const result = await uploadWallFile(file);
        setUploaded((current) => [result, ...current]);
        if (asPreview) setDraft((current) => ({ ...current, previewFileId: result.id }));
        else setDraft((current) => ({ ...current, fileIds: [...current.fileIds, result.id] }));
      }
    } catch (error) {
      toast(errorMessage(error, "Не удалось загрузить файл"), "error");
    } finally {
      setBusy(false);
    }
  };

  const close = () => {
    // Files uploaded in this editor and not saved anywhere are removed.
    cleanupFiles(uploaded.map((file) => file.id));
    onClose();
  };

  const save = async () => {
    if (!draft.title.trim()) return;
    setBusy(true);
    try {
      const body = { ...draft, serviceId: draft.serviceId || null };
      const next = await api<WallListData>(post ? `/api/wall/posts/${post.id}` : "/api/wall/posts", { method: post ? "PUT" : "POST", body });
      cleanupFiles(uploaded.filter((file) => !draft.fileIds.includes(file.id) && draft.previewFileId !== file.id).map((file) => file.id));
      toast(post ? "Пост сохранён" : "Пост опубликован");
      onSaved(next);
    } catch (error) {
      toast(errorMessage(error, "Не удалось сохранить пост"), "error");
      setBusy(false);
    }
  };

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    if (event.dataTransfer.files.length) void upload(event.dataTransfer.files);
  };

  return (
    <Modal
      title={post ? "Редактирование поста" : "Новый пост"}
      size="lg"
      onClose={close}
      footer={
        <>
          <button className="btn btn-ghost" type="button" onClick={close}>
            Отмена
          </button>
          <button className="btn btn-primary" type="button" disabled={!draft.title.trim() || busy} onClick={save}>
            {busy && <Spinner />}
            {post ? "Сохранить" : "Опубликовать"}
          </button>
        </>
      }
    >
      <div className="form">
        <div className="form-grid">
          <Field label="Заголовок">
            <input autoFocus value={draft.title} maxLength={160} onChange={(event) => setDraft({ ...draft, title: event.target.value })} />
          </Field>
          <Field label="Сервис">
            <select value={draft.serviceId} onChange={(event) => setDraft({ ...draft, serviceId: event.target.value })}>
              <option value="">Для всех</option>
              {state.services.map((service) => (
                <option key={service.id} value={service.id}>
                  {service.name}
                </option>
              ))}
            </select>
          </Field>
        </div>

        {tags.length > 0 && (
          <div className="field">
            <span className="field-label">Теги</span>
            <div className="tag-picker">
              {tags.map((tag) => (
                <TagChip
                  key={tag.id}
                  tag={tag}
                  selected={draft.tagIds.includes(tag.id)}
                  onClick={() =>
                    setDraft((current) => ({
                      ...current,
                      tagIds: current.tagIds.includes(tag.id) ? current.tagIds.filter((item) => item !== tag.id) : [...current.tagIds, tag.id]
                    }))
                  }
                />
              ))}
            </div>
          </div>
        )}

        <div className="field">
          <span className="field-label">Текст</span>
          <div className="editor-toolbar">
            <label className="btn btn-ghost btn-sm">
              <Upload size={15} />
              Прикрепить файл
              <input hidden multiple type="file" disabled={busy} onChange={(event) => upload(event.target.files)} />
            </label>
            <label className="btn btn-ghost btn-sm">
              <ImagePlus size={15} />
              {preview ? "Сменить обложку" : "Обложка"}
              <input hidden type="file" accept="image/png,image/jpeg,image/webp,image/gif" disabled={busy} onChange={(event) => upload(event.target.files, true)} />
            </label>
            {busy && <Spinner />}
          </div>
          <div
            className={classNames("drop-zone", dragging && "dragging")}
            onDragEnter={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragOver={(event) => event.preventDefault()}
            onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
            }}
            onDrop={onDrop}
          >
            <textarea ref={textRef} rows={12} aria-label="Текст поста" value={draft.content} onChange={(event) => setDraft({ ...draft, content: event.target.value })} />
            <span className="drop-hint">Перетащите файлы сюда</span>
          </div>
          <span className="field-hint">Ссылка: [текст](https://…). Картинка из вложений вставляется кнопкой рядом с файлом.</span>
        </div>

        {preview && (
          <div className="cover-preview">
            <img src={preview.url} alt="Обложка" />
            <button className="btn btn-ghost btn-sm" type="button" onClick={() => setDraft({ ...draft, previewFileId: null })}>
              <X size={14} />
              Убрать обложку
            </button>
          </div>
        )}

        {draftFiles.length > 0 && (
          <ul className="editor-files">
            {draftFiles.map((file) => (
              <li key={file.id}>
                <Paperclip size={14} />
                <span className="grow">{file.originalName}</span>
                <small className="muted">{fileSize(file.size)}</small>
                <button className="link-btn" type="button" onClick={() => insert(`[${file.originalName}](${file.url})`)}>
                  Вставить ссылку
                </button>
                {isImage(file) && (
                  <>
                    <button className="link-btn" type="button" onClick={() => insert(`![${file.originalName}|720](${file.url})`)}>
                      В текст
                    </button>
                    <button className="link-btn" type="button" onClick={() => setDraft({ ...draft, previewFileId: file.id })}>
                      Обложкой
                    </button>
                  </>
                )}
                <button className="icon-btn" type="button" aria-label={`Открепить ${file.originalName}`} onClick={() => setDraft({ ...draft, fileIds: draft.fileIds.filter((item) => item !== file.id) })}>
                  <X size={14} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}

/* --------------------------------------------------------------------- tags */

function TagsModal({ tags, onChanged, onClose }: { tags: WallTag[]; onChanged: (next: WallListData) => void; onClose: () => void }) {
  const { toast, confirm } = useFeedback();
  const [name, setName] = useState("");
  const [color, setColor] = useState("#6d8dff");

  const call = async (path: string, method: string, body?: unknown) => {
    try {
      onChanged(await api<WallListData>(path, { method, body }));
      return true;
    } catch (error) {
      toast(errorMessage(error), "error");
      return false;
    }
  };

  return (
    <Modal title="Теги" description="Закрепляющий тег поднимает пост наверх, архивный — убирает его в архив" onClose={onClose}>
      <form
        className="tag-create"
        onSubmit={async (event) => {
          event.preventDefault();
          if (name.trim() && (await call("/api/wall/tags", "POST", { name, color }))) setName("");
        }}
      >
        <input type="color" aria-label="Цвет тега" value={color} onChange={(event) => setColor(event.target.value)} />
        <input placeholder="Название нового тега" aria-label="Название тега" value={name} maxLength={48} onChange={(event) => setName(event.target.value)} />
        <button className="btn btn-primary" type="submit" disabled={!name.trim()}>
          <Plus size={16} />
          Создать
        </button>
      </form>
      {tags.length ? (
        <ul className="tag-manager">
          {tags.map((tag) => (
            <li key={tag.id}>
              <TagChip tag={tag} />
              <Switch checked={tag.pinned} label="Закрепляет" onChange={(value) => void call(`/api/wall/tags/${tag.id}`, "PUT", { ...tag, pinned: value })} />
              <Switch checked={tag.archived} label="Архив" onChange={(value) => void call(`/api/wall/tags/${tag.id}`, "PUT", { ...tag, archived: value })} />
              <button
                className="icon-btn danger"
                type="button"
                aria-label={`Удалить тег ${tag.name}`}
                onClick={async () => {
                  const answer = await confirm({ title: `Удалить тег «${tag.name}»?`, message: "Тег снимется со всех постов.", confirmLabel: "Удалить", tone: "danger" });
                  if (answer !== null) await call(`/api/wall/tags/${tag.id}`, "DELETE");
                }}
              >
                <Trash2 size={16} />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <Empty icon={Tag} title="Тегов пока нет" />
      )}
    </Modal>
  );
}
