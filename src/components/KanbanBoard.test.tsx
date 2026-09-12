import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import KanbanBoard from './KanbanBoard';
import MarkdownPreview from './MarkdownPreview';
import { applySourceChanges, parseKanban, type KanbanChange } from '../lib/kanban';
const original='---\nlocalview: kanban\n---\n# Board\n\n## Todo\n\n- [ ] First #work\n  Description\n  - [ ] Step\n\n- [x] Second\n\n## Doing\n\n';
function Harness({initial=original,enabled=true,onApply=vi.fn()}: {initial?:string;enabled?:boolean;onApply?:(c:KanbanChange)=>void}) {
  const [source,setSource]=useState(initial), [past,setPast]=useState<string[]>([]);
  const b=parseKanban(source); if(b.kind!=='board') throw Error('Invalid harness board');
  return <><KanbanBoard board={b} documentKey="board" onChange={enabled?change=>{onApply(change); setPast([...past,source]);setSource(applySourceChanges(source,change.changes)!);return true;}:undefined}
    onHistory={()=>{const prev=past[past.length-1];if(prev===undefined)return false;setSource(prev);setPast(past.slice(0,-1));return true;}}/>
    <output data-testid="source">{source}</output><button onClick={()=>setSource(source.replace('First','External'))}>External update</button></>;
}
const content=()=>screen.getByTestId('source').textContent!;
const openFirst=()=>fireEvent.click(screen.getByRole('button',{name:'First #work'}));
describe('Kanban real React interactions',()=>{
  it('opens a right-side detail editor and immediately edits the same Markdown',()=>{
    render(<Harness/>);openFirst();
    fireEvent.change(screen.getByLabelText('卡片标题'),{target:{value:'Renamed #work'}});
    expect(content()).toContain('- [ ] Renamed #work');
    fireEvent.change(screen.getByLabelText('卡片说明与子任务'),{target:{value:'Details\n- [ ] New step'}});
    expect(content()).toContain('  Details\n  - [ ] New step\n');
    fireEvent.click(screen.getByRole('checkbox',{name:'New step'}));
    expect(content()).toContain('  - [x] New step');
    fireEvent.click(screen.getByLabelText('关闭卡片详情'));expect(screen.queryByLabelText('卡片详情')).toBeNull();
  });
  it('supports incremental multiline typing and spaces in column names',async()=>{
    const user=userEvent.setup();render(<Harness/>);openFirst();
    const body=screen.getByLabelText('卡片说明与子任务');await user.clear(body);await user.type(body,'Line one{Enter}Line two');
    expect((body as HTMLTextAreaElement).value).toBe('Line one\nLine two');
    expect(content()).toContain('  Line one\n  Line two\n');
    fireEvent.click(screen.getByLabelText('关闭卡片详情'));await user.click(screen.getByRole('button',{name:'Todo 列操作'}));
    const name=screen.getByLabelText('列名');await user.clear(name);await user.type(name,'In review');
    expect(content()).toContain('## In review');
  });
  it('adds multiple cards through Enter and clears the inline field',()=>{
    render(<Harness/>);fireEvent.click(within(screen.getByLabelText('列：Doing')).getByRole('button',{name:'＋ 添加卡片'}));
    const input=screen.getByLabelText('新卡片标题');
    for(const title of ['Third','Fourth']){fireEvent.change(input,{target:{value:title}});fireEvent.keyDown(input,{key:'Enter'});}
    expect(content()).toContain('- [ ] Third\n\n- [ ] Fourth');expect((input as HTMLInputElement).value).toBe('');
    fireEvent.keyDown(input,{key:'Escape'});expect(screen.queryByLabelText('新卡片标题')).toBeNull();
  });
  it('does not submit a card during IME confirmation',()=>{
    render(<Harness/>);fireEvent.click(within(screen.getByLabelText('列：Doing')).getByRole('button',{name:'＋ 添加卡片'}));
    const input=screen.getByLabelText('新卡片标题');fireEvent.change(input,{target:{value:'中文'}});
    fireEvent.keyDown(input,{key:'Enter',isComposing:true,keyCode:229});expect(content()).toBe(original);
    fireEvent.keyDown(input,{key:'Enter'});expect(content()).toContain('- [ ] 中文');
  });
  it('moves through the accessible selector without inferring completion',()=>{
    render(<Harness/>);openFirst();fireEvent.change(screen.getByLabelText('卡片所在列'),{target:{value:String(original.indexOf('## Doing'))}});
    expect(within(screen.getByLabelText('列：Doing')).getByRole('button',{name:'First #work'})).not.toBeNull();
    expect(content()).toContain('- [ ] First');expect(content().indexOf('## Doing')).toBeLessThan(content().indexOf('- [ ] First'));
  });
  it('supports column rename, accessible reorder and additions',()=>{
    render(<Harness/>);fireEvent.click(screen.getByRole('button',{name:'Todo 列操作'}));
    fireEvent.change(screen.getByLabelText('列名'),{target:{value:'Ready'}});expect(content()).toContain('## Ready');
    fireEvent.click(screen.getByRole('button',{name:'向右移动'}));expect(content().indexOf('## Doing')).toBeLessThan(content().indexOf('## Ready'));
    fireEvent.click(screen.getAllByRole('button',{name:'＋ 添加列'})[0]);fireEvent.change(screen.getByLabelText('新列名称'),{target:{value:'Review'}});
    fireEvent.keyDown(screen.getByLabelText('新列名称'),{key:'Enter'});expect(content()).toContain('## Review');
  });
  it('confirms deletion, defaults focus to cancel and supports shared undo',()=>{
    render(<Harness/>);openFirst();fireEvent.click(screen.getByRole('button',{name:'删除卡片…'}));
    const dialog=screen.getByRole('alertdialog');expect(document.activeElement).toBe(within(dialog).getByRole('button',{name:'取消'}));
    fireEvent.click(within(dialog).getByRole('button',{name:'取消'}));expect(content()).toBe(original);
    fireEvent.click(screen.getByRole('button',{name:'删除卡片…'}));fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button',{name:'删除'}));
    expect(content()).not.toContain('First');fireEvent.click(screen.getByRole('button',{name:'撤销'}));expect(content()).toBe(original);
  });
  it('moves the full group before deleting a nonempty column',()=>{
    render(<Harness/>);fireEvent.click(screen.getByRole('button',{name:'Todo 列操作'}));fireEvent.click(screen.getByRole('button',{name:'删除列…'}));
    expect(screen.getByRole('alertdialog').textContent).toContain('2 张卡片');fireEvent.click(screen.getByRole('button',{name:'移动卡片并删除列'}));
    const b=parseKanban(content());expect(b.kind==='board'&&b.columns.length).toBe(1);expect(b.kind==='board'&&b.columns[0].cards.length).toBe(2);
    expect(content()).toContain('Description');
  });
  it('cancels an open deletion and selection when external source changes',()=>{
    render(<Harness/>);openFirst();fireEvent.click(screen.getByRole('button',{name:'删除卡片…'}));
    fireEvent.click(screen.getByRole('button',{name:'External update'}));expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(content()).toContain('External');expect(screen.queryByLabelText('卡片详情')).toBeNull();
  });
  it('disables mutations in a locked workspace but allows reading details',()=>{
    const onApply=vi.fn();render(<Harness enabled={false} onApply={onApply}/>);openFirst();
    expect((screen.getByLabelText('卡片标题') as HTMLInputElement).disabled).toBe(true);expect((screen.getByRole('button',{name:'删除卡片…'}) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button',{name:'拖动卡片 First #work'}) as HTMLButtonElement).disabled).toBe(true);expect(onApply).not.toHaveBeenCalled();
  });
  it('rejects a stale operation when the editor refuses it',()=>{
    const b=parseKanban(original);if(b.kind!=='board')throw Error(); const onChange=vi.fn(()=>false);
    render(<KanbanBoard board={b} documentKey="doc" onChange={onChange}/>);
    fireEvent.click(screen.getByLabelText('完成：First #work'));expect(onChange).toHaveBeenCalledTimes(1);
    expect((screen.getByLabelText('完成：First #work') as HTMLInputElement).checked).toBe(false);expect(screen.getByRole('status').textContent).toContain('操作未应用');
  });
  it('renders ordinary Markdown unchanged and malformed marked boards as original source',()=>{
    const props={desktop:false,rootPath:'/workspace',selectedPath:'/workspace/board.md',assetScope:''};
    const view=render(<MarkdownPreview {...props} content={'# Ordinary\n- [ ] task'}/>);
    expect(screen.queryByLabelText('Markdown 看板')).toBeNull();expect(screen.getByRole('heading',{name:'Ordinary'})).not.toBeNull();
    view.rerender(<MarkdownPreview {...props} content={original+'unowned prose'}/>);
    expect(screen.queryByLabelText('Markdown 看板')).toBeNull();expect(view.container.querySelector('pre')?.textContent).toBe(original+'unowned prose');
  });
});
