// Homepage display is read-only. Notes are created only by an explicit action.
class Dashboard {
  constructor(plugin){this.plugin=plugin;}
  today(dv){return dv.date('today').toISODate();}
  link(parent,path,label){
    const anchor=parent.createEl('a',{text:label,cls:'internal-link',attr:{href:path,'data-href':path}});
    anchor.addEventListener('click',event=>{
      event.preventDefault();
      event.stopPropagation();
      return this.plugin.safe(()=>this.plugin.app.workspace.openLinkText(path,'MOC.md',!!(event.ctrlKey||event.metaKey)));
    });
    return anchor;
  }
  action(parent,label,run,cls=''){
    const button=parent.createEl('button',{text:label,cls,attr:{type:'button'}});
    button.addEventListener('click',async()=>{
      button.disabled=true;
      try{await this.plugin.safe(run);}finally{button.disabled=false;}
    });
    return button;
  }
  async start(dv){
    await this.plugin.engine.loadLegacy();
    const today=this.today(dv),[y,m,d]=today.split('-').map(Number);
    const weekday='日一二三四五六'[new Date(Date.UTC(y,m-1,d)).getUTCDay()];
    const panel=dv.container.createEl('div',{cls:'journal-start'});
    panel.createEl('p',{text:`${y}年${m}月${d}日 · 星期${weekday}`,cls:'journal-date'});
    const actions=panel.createEl('div',{cls:'journal-today-actions'});
    const existing=this.plugin.app.vault.getAbstractFileByPath(this.plugin.engine.path('daily',today));
    this.action(actions,existing?'继续今天的日记':'写今天的日记',()=>this.plugin.engine.open('daily',this.today(dv)),'journal-primary');
    const periods=panel.createEl('div',{cls:'journal-periods',attr:{role:'group','aria-label':'当前计划'}});
    periods.createEl('span',{text:'当前计划',cls:'journal-label'});
    for(const [kind,label] of [['weekly','本周'],['monthly','本月'],['quarterly','本季'],['yearly','今年']]){
      this.action(periods,label,()=>this.plugin.engine.open(kind,this.today(dv)));
    }
    this.link(periods,'总体目标.md','总体目标 →');
  }
  navigation(dv){
    // dv.el renders even an empty string into a child span. Create layout
    // containers directly so the grid contains exactly the three cards.
    const grid=dv.container.createEl('div',{cls:'journal-blocks'});
    for(const [kind,title,description,path,action] of [
      ['daily','Daily · 日记与计划','安排时间，记录行动、经历与感受。','01. Daily/README.md','浏览日记 →'],
      ['decision','Decisions · 问题研究','记录实际问题、思考与选择。','02. Decisions/README.md','进入目录 →'],
      ['manual','Manual · 技能手册','积累实践中形成的技能与方法。','03. Manual/README.md','进入目录 →']
    ]){
      const card=grid.createEl('div',{cls:'journal-card journal-'+kind});
      const heading=card.createEl('h3');this.link(heading,path,title);
      card.createEl('p',{text:description});
      this.link(card,path,action);
    }
  }
  recent(dv){
    const panel=dv.container.createEl('div',{cls:'journal-recent'});
    // Old diaries have date filenames but may have no frontmatter.
    const pages=dv.pages('"01. Daily"').where(p=>p.file.path.startsWith('01. Daily/')&&(p.type==='daily'||/^\d{4}-\d{2}-\d{2}$/.test(p.file.name))).sort(p=>p.file.name,'desc').slice(0,5);
    if(pages.length){
      const list=panel.createEl('ul');
      for(const page of pages)this.link(list.createEl('li'),page.file.path,page.file.name);
    }else panel.createEl('p',{text:'还没有日记。从“写今天的日记”开始即可。',cls:'journal-empty'});
    this.link(panel,'01. Daily/README.md','全部日记与年份目录 →');
  }
}
module.exports={Dashboard};
