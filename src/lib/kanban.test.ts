import { describe, expect, it } from 'vitest';
import { applySourceChanges, isKanbanSource, kanbanChange, kanbanTemplate, parseKanban, KANBAN_MAX_SOURCE, type KanbanAction } from './kanban';
const source = '---\nlocalview: kanban\nowner: unchanged\n---\n\n# Board 😀\n\nIntroduction.\n\n## Todo\n\n- [ ] Same #work\n  description\n  - [x] child\n\n- [ ] Second\n\n## Doing\n\n- [X] Same\n  body\n\n## Done\n\n';
function board(s = source) { const b = parseKanban(s); if (b.kind !== 'board') throw new Error(JSON.stringify(b)); return b; }
function change(s: string, a: KanbanAction) { const c = kanbanChange(s, a); expect(c).not.toBeNull(); return applySourceChanges(s, c!.changes)!; }
describe('source-preserving Markdown Kanban', () => {
  it('does not interpret ordinary task documents or other frontmatter as boards', () => {
    for (const s of ['## Todo\n- [ ] A', '---\ntitle: kanban\n---\n## Todo', '```\n---\nlocalview: kanban\n---\n```']) {
      expect(parseKanban(s).kind).toBe('plain'); expect(isKanbanSource(s)).toBe(false);
    }
  });
  it('parses columns, duplicate titles, tags, descriptions and semantic subtasks', () => {
    const b = board(); expect(b.title).toBe('Board 😀'); expect(b.intro).toBe('Introduction.');
    expect(b.columns.map(c => c.title)).toEqual(['Todo', 'Doing', 'Done']);
    expect(b.columns[0].cards[0].tasks).toEqual([{ statusOffset: source.indexOf('[x]') + 1, checked: true, title: 'child' }]);
    expect(b.columns[1].cards[0].checked).toBe(true);
  });
  it('recognizes BOM and quoted marker without normalizing unrelated frontmatter', () => {
    const s = '\uFEFF' + source.replace('localview: kanban', 'localview: "kanban" # board');
    const b = board(s); const next = change(s, { type: 'toggle', statusOffset: b.columns[0].cards[0].statusOffset, checked: true });
    expect(next).toBe(s.replace('- [ ] Same', '- [x] Same'));
  });
  it('fails closed for incomplete or duplicate marker', () => {
    expect(parseKanban('---\nlocalview: kanban\n').kind).toBe('invalid');
    expect(parseKanban(source.replace('owner: unchanged', 'localview: other')).kind).toBe('invalid');
  });
  it.each(['ordinary paragraph', '> quoted', '### unexpected', '- plain bullet', '```\n## fake\n```'])('keeps unowned column content intact: %s', text => {
    const s = kanbanTemplate() + text; expect(parseKanban(s).kind).toBe('invalid');
    expect(kanbanChange(s, { type: 'add-column', title: 'No' })).toBeNull();
  });
  it('ignores code, HTML and quoted heading examples in the introduction', () => {
    const s = source.replace('Introduction.', '```md\n## fake\n- [ ] fake\n```\n\n> ## quote\n\n<div>\n## html\n</div>');
    expect(board(s).columns).toHaveLength(3);
  });
  it('does not make fenced task examples into actionable subtasks', () => {
    const s = source.replace('  description', '  ```md\n  ## not a column\n  - [ ] not a subtask\n  ```');
    const b = board(s); expect(b.columns[0].cards[0].tasks).toHaveLength(1);
    expect(kanbanChange(s, { type: 'toggle', statusOffset: s.indexOf('[ ] not') + 1, checked: true })).toBeNull();
  });
  it('rejects lazy unindented continuation instead of moving unrelated prose', () => {
    expect(parseKanban(source.replace('  description', 'description')).kind).toBe('invalid');
  });
  it.each(['\n', '\r\n', '\r', '\r\n\n'])('moves complete cards preserving %j and non-target bytes', eol => {
    const s = source.replace(/\n/g, eol); const b = board(s), item = b.columns[0].cards[0];
    const next = change(s, { type: 'move-card', card: item.from, column: b.columns[2].from, before: null });
    expect(next).toBe(s.slice(0,item.from) + s.slice(item.to) + s.slice(item.from,item.to));
    expect(board(next).columns[2].cards[0].body).toBe(item.body);
  });
  it('moves between mixed line-ending blocks without rewriting either block', () => {
    const s = source.replace('  description\n', '  description\r\n').replace('## Doing\n', '## Doing\r');
    const b = board(s), item=b.columns[1].cards[0];
    const next=change(s,{type:'move-card',card:item.from,column:b.columns[0].from,before:b.columns[0].cards[0].from});
    expect(next).toContain(s.slice(item.from,item.to)); expect(board(next).columns[0].cards).toHaveLength(3);
  });
  it('handles a final card without newline moving before another card', () => {
    const s = '---\nlocalview: kanban\n---\n## One\n- [ ] A\n## Two\n- [ ] B'; const b=board(s);
    const next=change(s,{type:'move-card',card:b.columns[1].cards[0].from,column:b.columns[0].from,before:b.columns[0].cards[0].from});
    expect(board(next).columns[0].cards.map(c=>c.title)).toEqual(['B','A']);
  });
  it('does not infer completion from destination column', () => {
    const b=board(); const next=change(source,{type:'move-card',card:b.columns[0].cards[0].from,column:b.columns[2].from,before:null});
    expect(board(next).columns[2].cards[0].checked).toBe(false);
  });
  it('reorders columns including their cards without a whole-document rewrite', () => {
    const b=board(), col=b.columns[2]; const c=kanbanChange(source,{type:'move-column',column:col.from,before:b.columns[0].from})!;
    expect(c.changes).toHaveLength(2); expect(board(applySourceChanges(source,c.changes)!).columns.map(c=>c.title)).toEqual(['Done','Todo','Doing']);
  });
  it('requires explicit confirmation before deleting a nonempty column', () => {
    const b=board(); expect(kanbanChange(source,{type:'delete-column',column:b.columns[0].from})).toBeNull();
    expect(board(change(source,{type:'delete-column',column:b.columns[0].from,deleteCards:true})).columns).toHaveLength(2);
  });
  it.each([0,2])('moves cards to column %i before deleting a nonempty column', target => {
    const b=board(); const next=change(source,{type:'delete-column',column:b.columns[1].from,destination:b.columns[target].from});
    const n=board(next); expect(n.columns).toHaveLength(2); expect(n.columns.flatMap(c=>c.cards)).toHaveLength(3);
    expect(n.columns[target===0?0:1].cards.slice(-1)[0]?.title).toBe('Same');
  });
  it('adds, edits, renames and removes columns and cards using source ranges', () => {
    let s=change(kanbanTemplate(),{type:'add-column',title:'Review'}); let b=board(s);
    s=change(s,{type:'add-card',column:b.columns[3].from,title:'Card'}); b=board(s); const item=b.columns[3].cards[0];
    s=change(s,{type:'edit-card',card:item.from,title:'Changed',body:'Details\n- [ ] Step'}); b=board(s);
    expect(b.columns[3].cards[0].body).toBe('Details\n- [ ] Step');
    s=change(s,{type:'rename-column',column:b.columns[3].from,title:'QA'}); b=board(s); expect(b.columns[3].title).toBe('QA');
    s=change(s,{type:'delete-card',card:b.columns[3].cards[0].from}); b=board(s); expect(b.columns[3].cards).toHaveLength(0);
    s=change(s,{type:'delete-column',column:b.columns[3].from}); expect(board(s).columns).toHaveLength(3);
  });
  it('allows clearing and retyping a card or column title in the controlled editor', () => {
    const b=board(); let s=change(source,{type:'edit-card',card:b.columns[0].cards[0].from,title:''});
    s=change(s,{type:'edit-card',card:board(s).columns[0].cards[0].from,title:'Retyped'}); expect(board(s).columns[0].cards[0].title).toBe('Retyped');
    s=change(s,{type:'rename-column',column:board(s).columns[0].from,title:''});
    s=change(s,{type:'rename-column',column:board(s).columns[0].from,title:'New'}); expect(board(s).columns[0].title).toBe('New');
  });
  it('rejects empty additions, newline titles, wrong offsets and no-op moves', () => {
    const b=board(); expect(kanbanChange(source,{type:'add-card',column:b.columns[0].from,title:' '})).toBeNull();
    expect(kanbanChange(source,{type:'add-column',title:'A\n## B'})).toBeNull();
    expect(kanbanChange(source,{type:'move-card',card:1234,column:b.columns[0].from,before:null})).toBeNull();
    expect(kanbanChange(source,{type:'move-column',column:b.columns[0].from,before:b.columns[0].from})).toBeNull();
  });
  it('rejects malformed source patches and code-unit splits', () => {
    expect(applySourceChanges('a\r\nb',[{from:2,to:2,insert:'!'}])).toBeNull();
    expect(applySourceChanges('😀',[{from:1,to:1,insert:'!'}])).toBeNull();
    expect(applySourceChanges('abc',[{from:2,to:3,insert:''},{from:0,to:1,insert:''}])).toBeNull();
    expect(applySourceChanges('abc',[{from:-1,to:0,insert:''}])).toBeNull();
  });
  it('bounds parsing by size and number of columns', () => {
    expect(parseKanban(kanbanTemplate()+'x'.repeat(KANBAN_MAX_SOURCE)).kind).toBe('invalid');
    expect(parseKanban(kanbanTemplate()+'## C\n\n'.repeat(101)).kind).toBe('invalid');
  });
});
