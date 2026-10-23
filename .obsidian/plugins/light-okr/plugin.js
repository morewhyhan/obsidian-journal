const {Plugin,Notice}=require('obsidian');
const {Engine,route,identify}=require('./core');
const {Dashboard}=require('./dashboard');
module.exports=class LightOKR extends Plugin {
  async onload(){
    this.engine=new Engine(this.app);this.dashboard=new Dashboard(this);this.processing=new Set();this.timers=new Set();await this.engine.loadLegacy();
    this.addCommand({id:'open-workspace',name:'打开首页',callback:()=>this.safe(()=>this.openWorkspace())});
    this.addRibbonIcon('layout-dashboard','首页',()=>this.safe(()=>this.openWorkspace()));
    const today=()=>{const d=new Date();return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');};
    for(const [kind,name] of [['daily','今天的日记'],['weekly','本周计划'],['monthly','本月计划'],['quarterly','本季计划'],['yearly','今年计划']])this.addCommand({id:'open-'+kind,name:'打开／创建'+name,callback:()=>this.safe(()=>this.engine.open(kind,today()))});
    this.addRibbonIcon('notebook-pen','今天的日记',()=>this.safe(()=>this.engine.open('daily',today())));
    this.registerEvent(this.app.vault.on('create',file=>{if(file.extension==='md'){const timer=setTimeout(()=>{this.timers.delete(timer);this.safe(()=>this.created(file));},500);this.timers.add(timer);}}));
    this.register(()=>{for(const t of this.timers)clearTimeout(t);});
    this.app.workspace.onLayoutReady(()=>{
      this.attachCalendar();this.registerInterval(setInterval(()=>this.attachCalendar(),3000));
      // Re-render pages that were opened before this plugin finished loading.
      const timer=setTimeout(()=>{this.timers.delete(timer);this.app.plugins.plugins.dataview?.index?.touch?.();},0);this.timers.add(timer);
    });
  }
  async openWorkspace(){const file=this.app.vault.getAbstractFileByPath('MOC.md');if(!file)throw Error('找不到首页 MOC.md');await this.app.workspace.getLeaf(false).openFile(file,{state:{mode:'preview'}});}
  async safe(fn){try{return await fn();}catch(e){console.error('轻量 OKR',e);new Notice('轻量 OKR：'+e.message);}}
  attachCalendar(){const controller=this.app.plugins.plugins['dust-calendar']?.noteController;if(!controller||controller===this.calendar)return;this.restoreCalendar?.();const original=controller.getNoteFilename;const kinds={1:'daily',2:'weekly',3:'monthly',4:'quarterly',5:'yearly'};
    const engine=this.engine;controller.getNoteFilename=function(d,type){if(!this.getNotePattern(type)||!kinds[type])return original.call(this,d,type);return engine.path(kinds[type],d.toISODate());};
    this.calendar=controller;this.restoreCalendar=()=>{controller.getNoteFilename=original;};this.register(this.restoreCalendar);
  }
  async created(file){if(this.processing.has(file.path)||!this.app.vault.getAbstractFileByPath(file.path))return;
    await this.engine.loadLegacy();if(this.engine.legacyFiles.has(file.path))return;
    let info=identify(file.path);if(!info)return;
    const canonical=route(info.kind,info.date);if(file.path!==canonical)return;
    const originalPath=file.path;this.processing.add(originalPath);
    try{await this.engine.ensureParents(info.kind,info.date);let text=await this.app.vault.read(file);
      if(!text.trim())await this.app.vault.modify(file,await this.engine.render(info.kind,canonical));
      else if(info.kind==='daily'){
        const frontmatter=text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
        if(!frontmatter||!/^type:\s*daily\s*$/m.test(frontmatter[1]))await this.app.vault.modify(file,(await this.engine.render(info.kind,canonical))+'\n'+text);
      }
    }finally{this.processing.delete(originalPath);}
  }
};
