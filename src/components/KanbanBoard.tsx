import { useEffect, useRef, useState } from 'react';
import { applySourceChanges, kanbanChange, type KanbanAction, type KanbanBoard as Board, type KanbanChange, type KanbanColumn } from '../lib/kanban';
import type { MarkdownTaskHistory } from '../lib/markdownTasks';
import DecisionDialog from './DecisionDialog';
import './kanban.css';

type Props = { board: Board; documentKey: string; onChange?: (change: KanbanChange) => boolean; onHistory?: (direction: MarkdownTaskHistory) => boolean };
type Drag = { kind: 'card' | 'column'; from: number; source: string; pointer: number; startX: number; startY: number; moved: boolean; element: HTMLElement };
type Drop = { column: number; before: number | null };
type DeleteTarget = { kind: 'card' | 'column'; from: number; title: string; source: string };

function DeleteColumnDialog({ column, columns, onCancel, onConfirm }: {
  column: KanbanColumn; columns: KanbanColumn[]; onCancel: () => void; onConfirm: (destination?: number) => void;
}) {
  const [destination, setDestination] = useState(String(columns.find(c => c.from !== column.from)?.from ?? ''));
  const root = useRef<HTMLElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    cancel.current?.focus();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  return <div className="decision-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onCancel(); }}>
    <section ref={root} className="decision-dialog" role="alertdialog" aria-modal="true" aria-labelledby="kanban-delete-title" onKeyDown={e => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onCancel(); }
      if (e.key !== 'Tab') return;
      const focusable = Array.from(root.current?.querySelectorAll<HTMLElement>('button:not(:disabled),select:not(:disabled)') ?? []);
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
    }}>
      <h2 id="kanban-delete-title">删除「{column.title}」？</h2>
      <p>这列有 {column.cards.length} 张卡片。可以先移动卡片，或确认一并删除。操作可撤销。</p>
      {columns.length > 1 ? <label className="kanban-field">将卡片移动到
        <select aria-label="删除列前的目标列" value={destination} onChange={e => setDestination(e.target.value)}>
          {columns.filter(c => c.from !== column.from).map(c => <option key={c.from} value={c.from}>{c.title || '未命名列'}</option>)}
        </select>
      </label> : null}
      <div className="decision-actions">
        <button ref={cancel} onClick={onCancel}>取消</button>
        {destination !== '' ? <button onClick={() => onConfirm(Number(destination))}>移动卡片并删除列</button> : null}
        <button className="destructive" onClick={() => onConfirm()}>删除列及卡片</button>
      </div>
    </section>
  </div>;
}

/** View state is transient; the sole document and undo history live in CodeMirror. */
export default function KanbanBoard({ board, documentKey, onChange, onHistory }: Props) {
  const [selected, setSelected] = useState<number | null>(null);
  const [adding, setAdding] = useState<number | 'column' | null>(null);
  const [title, setTitle] = useState('');
  const [bodyDraft, setBodyDraft] = useState<{ from: number; source: string; value: string } | null>(null);
  const [menu, setMenu] = useState<number | null>(null);
  const [deleting, setDeleting] = useState<DeleteTarget | null>(null);
  const [notice, setNotice] = useState('');
  const [dragging, setDragging] = useState(false);
  const [feedback, setFeedback] = useState<{ x: number; y: number; drop: Drop | null } | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const detailTitle = useRef<HTMLInputElement>(null);
  const drag = useRef<Drag | null>(null);
  const drop = useRef<Drop | null>(null);
  const expected = useRef(board.source);
  const observed = useRef({ source: board.source, documentKey });
  const latest = useRef({ board, onChange, onHistory, documentKey });
  latest.current = { board, onChange, onHistory, documentKey };
  const enabled = !!onChange;
  const card = board.columns.flatMap(c => c.cards).find(c => c.from === selected);
  const cardColumn = board.columns.find(c => c.cards.some(item => item.from === selected));

  function stopDrag() {
    const current = drag.current;
    drag.current = null; drop.current = null;
    if (current?.element.hasPointerCapture?.(current.pointer)) current.element.releasePointerCapture(current.pointer);
    setDragging(false); setFeedback(null);
  }
  function closeDetails() {
    setSelected(null);
    root.current?.focus();
  }
  function perform(action: KanbanAction, snapshot = board.source) {
    const current = latest.current;
    if (!current.onChange || snapshot !== current.board.source) {
      setNotice('文档或操作状态已变化，请重新操作。'); return false;
    }
    const change = kanbanChange(snapshot, action);
    if (!change) { setNotice('无法安全执行此操作。请检查名称或卡片 Markdown 格式；原文未修改。'); return false; }
    const next = applySourceChanges(snapshot, change.changes)!;
    expected.current = next;
    if (!current.onChange(change)) {
      expected.current = current.board.source;
      setNotice('操作未应用：文档已变化、正在保存切换，或编辑器尚未就绪。'); return false;
    }
    setNotice('已更新 Markdown · 可撤销');
    if (!['edit-card', 'toggle'].includes(action.type)) setSelected(null);
    return true;
  }
  const performRef = useRef(perform);
  performRef.current = perform;

  useEffect(() => {
    const changedDocument = observed.current.documentKey !== documentKey;
    if (changedDocument || (observed.current.source !== board.source && expected.current !== board.source)) {
      setSelected(null); setAdding(null); setMenu(null); setDeleting(null); setTitle(''); stopDrag();
      setNotice(changedDocument ? '' : '源码已更新，已取消过期的卡片操作。');
    } else if (drag.current && drag.current.source !== board.source) stopDrag();
    expected.current = board.source;
    observed.current = { source: board.source, documentKey };
  }, [board.source, documentKey]);
  useEffect(() => { if (!enabled) { stopDrag(); setMenu(null); setDeleting(null); } }, [enabled]);
  useEffect(() => { if (adding !== null) field.current?.focus(); }, [adding]);
  useEffect(() => { if (selected !== null) detailTitle.current?.focus(); }, [selected]);
  useEffect(() => {
    if (menu === null) return;
    const close = (e: PointerEvent) => { if (!(e.target instanceof Element) || !e.target.closest('.kanban-column-menu')) setMenu(null); };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [menu]);

  useEffect(() => {
    if (!dragging) return;
    const targetAt = (event: PointerEvent): Drop | null => {
      const current = drag.current;
      const view = latest.current;
      if (!current || !view.onChange || current.source !== view.board.source) return null;
      const hit = document.elementFromPoint(event.clientX, event.clientY);
      if (!hit || !scroll.current?.contains(hit)) return null;
      const colElement = hit.closest<HTMLElement>('[data-kanban-column]');
      const col = view.board.columns.find(c => c.from === Number(colElement?.dataset.kanbanColumn));
      if (!col || !colElement) return null;
      if (current.kind === 'column') {
        const bounds = colElement.getBoundingClientRect();
        const i = view.board.columns.indexOf(col);
        return { column: col.from, before: event.clientX < bounds.left + bounds.width / 2 ? col.from : view.board.columns[i + 1]?.from ?? null };
      }
      const items = Array.from(colElement.querySelectorAll<HTMLElement>('[data-kanban-card]'));
      const before = items.find(el => { const box = el.getBoundingClientRect(); return event.clientY < box.top + box.height / 2; });
      return { column: col.from, before: before ? Number(before.dataset.kanbanCard) : null };
    };
    const move = (event: PointerEvent) => {
      const current = drag.current;
      if (!current || current.pointer !== event.pointerId) return;
      if (!latest.current.onChange || current.source !== latest.current.board.source) { stopDrag(); return; }
      if (Math.hypot(event.clientX - current.startX, event.clientY - current.startY) >= 5) current.moved = true;
      if (!current.moved) return;
      event.preventDefault();
      const el = scroll.current;
      if (el) {
        const box = el.getBoundingClientRect();
        if (event.clientY >= box.top && event.clientY <= box.bottom) {
          el.scrollLeft += event.clientX > box.right - 32 ? 18 : event.clientX < box.left + 32 ? -18 : 0;
          el.scrollTop += event.clientY > box.bottom - 32 ? 18 : event.clientY < box.top + 32 ? -18 : 0;
        }
      }
      drop.current = targetAt(event);
      setFeedback({ x: event.clientX, y: event.clientY, drop: drop.current });
    };
    const up = (event: PointerEvent) => {
      const current = drag.current;
      if (!current || current.pointer !== event.pointerId) return;
      const dest = targetAt(event);
      stopDrag();
      if (!current.moved || !dest) return;
      performRef.current(current.kind === 'card'
        ? { type: 'move-card', card: current.from, ...dest }
        : { type: 'move-column', column: current.from, before: dest.before }, current.source);
    };
    const escape = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); stopDrag(); } };
    const cancel = () => stopDrag();
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('blur', cancel);
    window.addEventListener('keydown', escape);
    return () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel); window.removeEventListener('blur', cancel); window.removeEventListener('keydown', escape);
      const current = drag.current;
      if (current?.element.hasPointerCapture?.(current.pointer)) current.element.releasePointerCapture(current.pointer);
      drag.current = null;
    };
  }, [dragging]);

  function startDrag(e: React.PointerEvent<HTMLButtonElement>, kind: Drag['kind'], from: number) {
    if (!enabled || e.button !== 0 || e.isPrimary === false || deleting) return;
    e.preventDefault(); e.stopPropagation(); setMenu(null);
    drag.current = { kind, from, source: board.source, pointer: e.pointerId, startX: e.clientX, startY: e.clientY, moved: false, element: e.currentTarget };
    e.currentTarget.setPointerCapture?.(e.pointerId); setDragging(true);
  }
  function add() {
    if (adding === null) return;
    if (perform(adding === 'column' ? { type: 'add-column', title } : { type: 'add-card', column: adding, title })) {
      setTitle(''); if (adding === 'column') setAdding(null); else field.current?.focus();
    }
  }
  function confirmDelete(destination?: number) {
    if (!deleting) return;
    perform(deleting.kind === 'card' ? { type: 'delete-card', card: deleting.from }
      : { type: 'delete-column', column: deleting.from, destination, deleteCards: destination === undefined }, deleting.source);
    setDeleting(null);
  }
  const addForm = <div className="kanban-add-form">
    <input ref={field} aria-label={adding === 'column' ? '新列名称' : '新卡片标题'} placeholder={adding === 'column' ? '列名称' : '写一张卡片…'} value={title} maxLength={1000} disabled={!enabled}
      onChange={e => setTitle(e.target.value)} onKeyDown={e => {
        if (e.nativeEvent.isComposing || e.keyCode === 229) return;
        // This draft is not in Markdown yet. Preserve the input's native undo/redo.
        if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'z') {
          e.stopPropagation(); return;
        }
        if (e.key === 'Enter') { e.preventDefault(); add(); }
        if (e.key === 'Escape') { e.stopPropagation(); setAdding(null); setTitle(''); }
      }} />
    <div><small>Enter 添加 · Esc 取消</small><button disabled={!enabled || !title.trim()} onClick={add}>添加</button><button onClick={() => { setAdding(null); setTitle(''); }}>取消</button></div>
  </div>;
  const deletingColumn = deleting?.kind === 'column' && board.columns.find(c => c.from === deleting.from);

  return <div ref={root} className={`kanban-pane${dragging ? ' kanban-dragging' : ''}`} tabIndex={-1} aria-label="Markdown 看板" onKeyDown={e => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'z' && !deleting) {
      e.preventDefault(); e.stopPropagation(); stopDrag();
      onHistory?.(e.shiftKey ? 'redo' : 'undo');
    }
    if (e.key === 'Escape' && !deleting) { stopDrag(); setMenu(null); setAdding(null); closeDetails(); }
  }}>
    <header className="kanban-heading"><div><small>MARKDOWN · 看板</small><h1>{board.title}</h1>{board.intro ? <p>{board.intro}</p> : null}</div>
      <div className="kanban-tools"><button disabled={!enabled} onClick={() => { setAdding('column'); setTitle(''); }}>＋ 添加列</button><button disabled={!onHistory || !enabled} onClick={() => onHistory?.('undo')}>撤销</button><button disabled={!onHistory || !enabled} onClick={() => onHistory?.('redo')}>重做</button></div>
    </header>
    <div className="kanban-caption">{board.columns.length} 列 · {board.columns.reduce((sum, c) => sum + c.cards.length, 0)} 张卡片 · 拖动把手排序，单击卡片编辑。完成勾选与所在列独立。</div>
    {!enabled ? <p className="kanban-warning" role="status">看板暂不可操作，正在等待当前文档操作完成。</p> : null}
    <div ref={scroll} className="kanban-scroll"><div className="kanban-columns">
      {board.columns.map((col, i) => <section key={col.from} className={`kanban-column${feedback?.drop?.before === col.from && drag.current?.kind === 'column' ? ' kanban-column-drop' : ''}`} data-kanban-column={col.from} aria-label={`列：${col.title || '未命名列'}`}>
        <header className="kanban-column-head"><button className="kanban-grip" aria-label={`拖动列 ${col.title}`} disabled={!enabled} onPointerDown={e => startDrag(e, 'column', col.from)}>⠿</button><h2>{col.title || '未命名列'}</h2><span>{col.cards.length}</span>
          <div className="kanban-column-menu"><button aria-label={`${col.title} 列操作`} aria-expanded={menu === col.from} disabled={!enabled} onClick={() => setMenu(menu === col.from ? null : col.from)}>•••</button>
            {menu === col.from ? <div className="kanban-menu" role="group" aria-label="列操作">
              <label>列名<input aria-label="列名" defaultValue={col.title} maxLength={1000} onChange={e => { if (e.target.value.trim() !== col.title) perform({ type: 'rename-column', column: col.from, title: e.target.value }); }} onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) setMenu(null); }} /></label>
              <button disabled={i === 0} onClick={() => { perform({ type: 'move-column', column: col.from, before: board.columns[i - 1].from }); setMenu(null); }}>向左移动</button>
              <button disabled={i === board.columns.length - 1} onClick={() => { perform({ type: 'move-column', column: col.from, before: board.columns[i + 2]?.from ?? null }); setMenu(null); }}>向右移动</button>
              <button className="destructive" onClick={() => { setDeleting({ kind: 'column', from: col.from, title: col.title, source: board.source }); setMenu(null); }}>删除列…</button>
            </div> : null}
          </div>
        </header>
        <div className="kanban-cards">
          {col.cards.map(item => <div key={item.from}>
            {drag.current?.kind === 'card' && feedback?.drop?.before === item.from ? <div className="kanban-drop-marker" /> : null}
            <article className={`kanban-card${item.checked ? ' is-done' : ''}${selected === item.from ? ' is-selected' : ''}`} data-kanban-card={item.from} onClick={e => { if (!(e.target instanceof Element) || !e.target.closest('button,input,label,a')) setSelected(item.from); }}>
              <div className="kanban-card-top"><input type="checkbox" aria-label={`完成：${item.title || '无标题卡片'}`} checked={item.checked} disabled={!enabled} onChange={e => perform({ type: 'toggle', statusOffset: item.statusOffset, checked: e.target.checked })} />
                <button className="kanban-card-title" onClick={() => { setSelected(item.from); setMenu(null); }}>{item.title || '无标题卡片'}</button>
                <button className="kanban-grip" aria-label={`拖动卡片 ${item.title}`} disabled={!enabled} onPointerDown={e => startDrag(e, 'card', item.from)}>⠿</button>
              </div>
              {item.body ? <p>{item.body}</p> : null}
              <footer>{(item.title.match(/(?:^|\s)#[\p{L}\p{N}_-]+/gu) ?? []).map((tag, n) => <small key={n} className="kanban-tag">{tag.trim()}</small>)}{item.tasks.length ? <small>{item.tasks.filter(t => t.checked).length}/{item.tasks.length} 子任务</small> : null}</footer>
            </article>
          </div>)}
          {drag.current?.kind === 'card' && feedback?.drop?.column === col.from && feedback.drop.before === null ? <div className="kanban-drop-marker" /> : null}
          {!col.cards.length ? <div className="kanban-empty-column">暂无卡片 · 可拖入这里</div> : null}
        </div>
        {adding === col.from ? addForm : <button className="kanban-add-card" disabled={!enabled} onClick={() => { setAdding(col.from); setTitle(''); }}>＋ 添加卡片</button>}
      </section>)}
      {adding === 'column' ? <div className="kanban-new-column">{addForm}</div> : <button className="kanban-add-column" disabled={!enabled} onClick={() => { setAdding('column'); setTitle(''); }}>＋ 添加列</button>}
    </div></div>
    <div className="kanban-notice" role="status" aria-live="polite">{notice || '文件仍是 Markdown · 修改自动保存到原文件'}</div>
    {card && cardColumn ? <aside className="kanban-detail" aria-label="卡片详情">
      <header><span>卡片详情</span><button aria-label="关闭卡片详情" onClick={closeDetails}>×</button></header>
      <div className="kanban-detail-body">
        <label className="kanban-field">标题<input ref={detailTitle} aria-label="卡片标题" maxLength={1000} value={card.title} disabled={!enabled} onChange={e => perform({ type: 'edit-card', card: card.from, title: e.target.value })} /></label>
        <label className="kanban-check"><input type="checkbox" aria-label="卡片已完成" checked={card.checked} disabled={!enabled} onChange={e => perform({ type: 'toggle', statusOffset: card.statusOffset, checked: e.target.checked })} />已完成（不自动移动列）</label>
        <label className="kanban-field">所在列<select aria-label="卡片所在列" value={cardColumn.from} disabled={!enabled} onChange={e => perform({ type: 'move-card', card: card.from, column: Number(e.target.value), before: null })}>{board.columns.map(c => <option key={c.from} value={c.from}>{c.title || '未命名列'}</option>)}</select></label>
        <div className="kanban-tools"><button disabled={!enabled || cardColumn.cards[0] === card} onClick={() => perform({ type: 'move-card', card: card.from, column: cardColumn.from, before: cardColumn.cards[cardColumn.cards.indexOf(card) - 1].from })}>上移卡片</button><button disabled={!enabled || cardColumn.cards[cardColumn.cards.length - 1] === card} onClick={() => perform({ type: 'move-card', card: card.from, column: cardColumn.from, before: cardColumn.cards[cardColumn.cards.indexOf(card) + 2]?.from ?? null })}>下移卡片</button></div>
        <label className="kanban-field">说明与子任务<textarea aria-label="卡片说明与子任务" value={bodyDraft?.from === card.from && bodyDraft.source === board.source ? bodyDraft.value : card.body.replace(/\r\n?/g, '\n')} disabled={!enabled} onChange={e => {
          const value = e.target.value;
          // Keep a trailing Enter in the field without multiplying Markdown block separators.
          const unchanged = value.replace(/\n+$/, '') === card.body.replace(/\r\n?/g, '\n');
          if (unchanged || perform({ type: 'edit-card', card: card.from, body: value }))
            setBodyDraft({ from: card.from, source: unchanged ? board.source : expected.current, value });
        }} /></label>
        <p className="kanban-help">使用 Markdown 编辑说明。输入「- [ ] 子任务」添加子任务；写回文件时自动缩进。没有独立保存按钮。</p>
        <div className="kanban-subtasks">{card.tasks.map(t => <label key={t.statusOffset}><input type="checkbox" checked={t.checked} disabled={!enabled} onChange={e => perform({ type: 'toggle', statusOffset: t.statusOffset, checked: e.target.checked })} />{t.title}</label>)}</div>
      </div>
      <footer><small>修改进入同一份 Markdown 和撤销历史</small><button className="destructive" disabled={!enabled} onClick={() => setDeleting({ kind: 'card', from: card.from, title: card.title, source: board.source })}>删除卡片…</button></footer>
    </aside> : null}
    {deletingColumn && deletingColumn.cards.length ? <DeleteColumnDialog column={deletingColumn} columns={board.columns} onCancel={() => setDeleting(null)} onConfirm={confirmDelete} />
      : deleting ? <DecisionDialog title={`删除${deleting.kind === 'card' ? '卡片' : '空列'}？`} message={`「${deleting.title}」将从 Markdown 中移除，可使用撤销恢复。`} confirmLabel="删除" cancelLabel="取消" destructive onCancel={() => setDeleting(null)} onConfirm={() => confirmDelete()} /> : null}
    {feedback && drag.current?.moved ? <div className="kanban-drag-ghost" style={{ left: feedback.x + 12, top: feedback.y + 12 }}>移动{drag.current.kind === 'card' ? '卡片' : '列'}</div> : null}
  </div>;
}
