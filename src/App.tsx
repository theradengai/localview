import { useState } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { markdown } from '@codemirror/lang-markdown';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import './style.css';

const demoFiles = [
  { name: 'README.md', type: 'md' },
  { name: 'docs', type: 'folder' },
  { name: 'prototype.html', type: 'html' },
  { name: 'assets', type: 'folder' }
];

export default function App() {
  const [file, setFile] = useState('README.md');
  const [mode, setMode] = useState<'edit'|'split'|'preview'>('split');
  const [text, setText] = useState('# LocalView\n\nOpen a file, see the folder context.\n\n- Markdown editing\n- HTML preview\n- No vault');

  return <div className="app">
    <header className="titlebar">
      <div className="dots"><i/><i/><i/></div>
      <div className="title">project / {file}</div>
      <div className="actions">LocalView MVP</div>
    </header>

    <div className="body">
      <aside className="sidebar">
        <div className="project">PROJECT</div>
        {demoFiles.map(f => <div className={file===f.name?'item active':'item'} key={f.name} onClick={()=>setFile(f.name)}>
          {f.type==='folder'?'▸':'◻'} {f.name}
        </div>)}
      </aside>

      <main className="main">
        <div className="toolbar">
          {['edit','split','preview'].map(m => <button className={mode===m?'active':''} onClick={()=>setMode(m as any)} key={m}>{m}</button>)}
        </div>
        <div className={mode==='split'?'content split':'content'}>
          {(mode==='edit'||mode==='split') && <div className="editor"><CodeMirror value={text} extensions={[markdown()]} onChange={setText}/></div>}
          {(mode==='preview'||mode==='split') && <div className="preview"><ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown></div>}
        </div>
      </main>
    </div>

    <footer>/Users/project/{file} · UTF-8</footer>
  </div>
}
