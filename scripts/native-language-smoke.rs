// Test-only controller copied into an isolated checkout by CI. Never linked into a release.
use std::{sync::{mpsc, Arc, Mutex}, time::Duration};
use tauri::{Listener, Manager};
use serde_json::{json, Value};

fn menu_items(items: Vec<tauri::menu::MenuItemKind<tauri::Wry>>, out: &mut Vec<(String,String)>) {
    use tauri::menu::MenuItemKind;
    for item in items {
        let id = format!("{:?}", item.id());
        match item {
            MenuItemKind::Submenu(x) => { out.push((id, x.text().unwrap())); menu_items(x.items().unwrap(), out); }
            MenuItemKind::MenuItem(x) => out.push((id, x.text().unwrap())),
            MenuItemKind::Predefined(x) => out.push((id, x.text().unwrap())),
            _ => {}
        }
    }
}
fn menu(app: &tauri::AppHandle) -> Vec<(String,String)> {
    let mut out = vec![];
    menu_items(app.menu().expect("native app menu").items().unwrap(), &mut out);
    out
}
struct Driver { app: tauri::AppHandle, receiver: mpsc::Receiver<Value>, id: u32 }
impl Driver {
    fn eval(&mut self, label: &str, code: &str) -> Value {
        self.id += 1;
        let id = self.id;
        let script = format!(r#"(() => {{
          const report = (ok, value) => window.__TAURI_INTERNALS__.invoke('plugin:event|emit', {{event:'localview-native-smoke-result', payload:{{id:{id}, ok, value}}}});
          const wait = async (test) => {{ for(let n=0;n<150;n++) {{ if(test()) return; await new Promise(r=>setTimeout(r,50)); }} throw new Error('Timed out: '+test.toString()); }};
          const choose = (value) => {{ const s=document.querySelector('.language-picker'); if(!s) throw new Error('Missing picker'); s.value=value; s.dispatchEvent(new Event('change',{{bubbles:true}})); }};
          Promise.resolve().then(async()=>{{ {code} }}).then(v=>report(true,v??null),e=>report(false,String(e)));
        }})();"#);
        self.app.get_webview_window(label).expect("exact owned window").eval(&script).unwrap();
        loop {
            let result=self.receiver.recv_timeout(Duration::from_secs(15)).expect("native bridge response");
            if result["id"].as_u64()==Some(id as u64) {
                assert_eq!(result["ok"],true,"{result}");
                return result["value"].clone();
            }
        }
    }
    fn language(&mut self,label:&str,value:&str) {
        self.eval(label,&format!("await wait(()=>document.querySelector('.language-picker')); choose('{}'); await wait(()=>document.documentElement.lang==='{}');",value,value));
    }
}
pub fn install(app: &tauri::AppHandle) {
    let (sender, receiver)=mpsc::channel();
    let sender=Arc::new(Mutex::new(sender));
    app.listen("localview-native-smoke-result",move |event| {
        if let Ok(value)=serde_json::from_str(event.payload()) { let _=sender.lock().unwrap().send(value); }
    });
    let app=app.clone();
    std::thread::spawn(move || {
        let outcome=std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let mut driver=Driver { app:app.clone(), receiver, id:0 };
            // Startup is intentionally a real temporary Markdown file, not a browser demo.
            driver.eval("main","await wait(()=>document.querySelector('.language-picker')); await wait(()=>document.querySelector('.mode-tabs')); return document.querySelector('.file-name')?.textContent;");
            driver.language("main","en");
            std::thread::sleep(Duration::from_millis(400));
            let initial=menu(&app);
            assert!(initial.iter().any(|(_,t)|t=="File"),"{initial:?}");
            driver.eval("main",r#"const edit=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='Edit'); if(!edit) throw new Error('Edit button missing'); edit.click(); await wait(()=>document.querySelector('.cm-editor')); window.__smokeEditor=document.querySelector('.cm-editor'); window.__smokeText=document.querySelector('.cm-content').textContent; return true;"#);
            driver.language("main","zh-CN");
            std::thread::sleep(Duration::from_millis(400));
            let chinese=menu(&app);
            assert!(chinese.iter().any(|(_,t)|t=="文件"),"{chinese:?}");
            assert!(chinese.iter().any(|(_,t)|t=="退出 LocalView"),"{chinese:?}");
            assert_eq!(initial.iter().map(|x|&x.0).collect::<Vec<_>>(),chinese.iter().map(|x|&x.0).collect::<Vec<_>>(),"menu IDs must not change");
            let second=driver.eval("main","return await window.__TAURI_INTERNALS__.invoke('new_workspace_window');").as_str().unwrap().to_string();
            driver.eval(&second,"await wait(()=>document.querySelector('.language-picker')); await wait(()=>document.documentElement.lang==='zh-CN'); return true;");
            driver.language(&second,"en");
            driver.eval("main","await wait(()=>document.documentElement.lang==='en'); if(window.__smokeEditor!==document.querySelector('.cm-editor')) throw new Error('Editor remounted'); if(window.__smokeText!==document.querySelector('.cm-content').textContent) throw new Error('Document rewritten'); return true;");
            std::thread::sleep(Duration::from_millis(400));
            assert_eq!(menu(&app),initial,"native menu must round trip exactly");
            // Multiple rapid changes must settle at the final explicit choice in both windows.
            driver.eval(&second,"choose('zh-CN'); choose('en'); choose('zh-CN'); return true;");
            driver.eval("main","await wait(()=>document.documentElement.lang==='zh-CN'); return true;");
            std::thread::sleep(Duration::from_millis(600));
            for label in ["main", second.as_str()] {
                assert_eq!(driver.eval(label,"return [document.documentElement.lang,document.querySelector('.language-picker').value];"),json!(["zh-CN","zh-CN"]));
            }
            let third=driver.eval("main","return await window.__TAURI_INTERNALS__.invoke('new_workspace_window');").as_str().unwrap().to_string();
            driver.eval(&third,"await wait(()=>document.querySelector('.language-picker')); await wait(()=>document.documentElement.lang==='zh-CN'); return true;");
            let system=driver.eval(&third,"choose('system'); return navigator.languages;");
            std::thread::sleep(Duration::from_millis(600));
            for label in ["main",second.as_str(),third.as_str()] { assert_eq!(driver.eval(label,"return document.querySelector('.language-picker').value;"),"system"); }
            let fixture=std::env::var("LOCALVIEW_SMOKE_FIXTURE").unwrap();
            assert_eq!(std::fs::read_to_string(fixture).unwrap(),"# 待办\n\nSynthetic native language fixture.\n","language switching must not write document bytes");
            json!({"passed":true,"windows":3,"checks":["real WKWebView picker","native menu label roundtrip","menu IDs preserved","native window propagation","new window preference","rapid switching","system preference propagation","editor DOM retained","original file bytes unchanged"],"systemLanguages":system,"englishMenu":initial,"chineseMenu":chinese})
        }));
        let result=match outcome { Ok(value)=>value, Err(error)=>json!({"passed":false,"error":error.downcast_ref::<String>().cloned().or_else(||error.downcast_ref::<&str>().map(|s|s.to_string())).unwrap_or_else(||"native smoke panicked".into())}) };
        let output=std::env::var("LOCALVIEW_SMOKE_RESULT").unwrap();
        std::fs::write(output,serde_json::to_vec_pretty(&result).unwrap()).unwrap();
        // Exit only this isolated test process. No global process lookup or UI-tree capture.
        std::process::exit(if result["passed"]==true {0} else {1});
    });
}
