/** Explicit requests for a concrete alternative may save a proposal, never execute it. */
export function proposalRequested(text: string) {
  if (
    /(?:只(?:是)?问|只回答|只(?:讨论|说明|测试)能力|不是让你|不需要.*(?:提案|方案))/u.test(
      text,
    )
  )
    return false;
  return /(?:要不要|该不该|是不是应该|是否应该|考虑|我想).*(?:每天|习惯|任务|安排|计划|提醒|学习|读|背|做)|(?:给我|提出|设计).*(?:方案|安排建议|提案)/u.test(
    text,
  );
}

/** Deterministic vetoes protect discussion from model-proposed writes; they do not grant new permissions. */
export function discussionOnly(text: string) {
  if (
    /(?:只(?:是)?(?:测试|说明|讨论|了解)能力|不是让你(?:真的)?(?:做|执行)|不是叫你(?:真的)?(?:做|执行))/u.test(
      text,
    )
  )
    return true;
  // Quoted material describes somebody else's instruction. Adoption requires
  // a separate user request, not commands embedded inside the quotation.
  if (
    /^(?:\s*>|以下是(?:一段|别人的|文章|原文)|(?:同事说|他说|她说|书里写|原文|引用)\s*[:：])/u.test(
      text.trim(),
    )
  )
    return true;
  if (
    /(?:只是|只|先|现在)(?:是|在)?(?:问你|问一下|问个|回答问题|聊一聊|聊天|讨论|复述|解释)|(?:没|没有|不是)(?:有)?(?:让你|叫你).{0,8}(?:执行|建|做任务|提交|落地)/u.test(
      text,
    )
  )
    return true;
  const command = commandRequest(text);
  if (
    !command &&
    /(?:先|暂时)?不要(?:真的)?(?:执行|创建|新建|提交|落地)/u.test(text)
  )
    return true;
  return (
    !command &&
    (/[?？]|是否|有没有|为什么|怎么回事|出了什么|什么/u.test(text) ||
      /^(?:(?:请|请你|帮我|你)?(?:分析|研究|讨论|比较|解释|说明|介绍|复述|阅读|读一下|看一下|列目录)|查看|查询|显示|所有安排|当前安排|待确认清单|我(?:好奇|想知道|想了解|确定一下|确认一下)|为什么|为啥|怎么|如何|你(?:能|会|可以|现在有什么)|我说什么|你先研究|研究一下|去研究|你查一下.*(?:为什么|问题)|还有一个问题)/u.test(
        text.trim(),
      ))
  );
}

// One command classifier is shared by context mode and execution. In
// particular a question inside an acceptance clause cannot veto “请建立”.
function commandRequest(text: string) {
  if (/^(?:请|帮我)?记住/u.test(text.trim())) return true;
  if (/(?:帮我|请你|麻烦你).*(?:排一下|排一排|排好)/u.test(text)) return true;
  return text.split(/[，,。；;！!\n]/u).some((part) => {
    const clause = part
      .trim()
      .replace(/^(?:然后|同时|另外|接着|再)[，,\s]*/u, "")
      .replace(/^(?:我想|我希望|我需要)(?:请你|让你|你|帮我)/u, "请帮我");
    if (/^(?:写进去|提交|落地|全部确认|全部执行)[。！!\s]*$/u.test(clause))
      return true;
    if (
      /(?:要不要|是否|是不是|该不该|考虑|也许|可能|不想|不需要|如果|假如|比方说|比如|我打算|我想|我准备|能不能|可以吗|不是让你)/u.test(
        clause,
      )
    )
      return false;
    if (
      /^(?:请|帮我)?(?:分析|研究|讨论|比较|解释|说明|介绍|设计|读|阅读|看)/u.test(
        clause,
      )
    )
      return false;
    if (
      /^(?:请)?(?:继续|接着|恢复)(?:刚才|之前|这个|当前|我的)?的?(?:番茄|专注|计时)/u.test(
        clause,
      )
    )
      return true;
    if (
      /(?:不要|别|停止|暂停|关闭|停用|关掉).*(?:提醒|联系|回顾|番茄|专注)/u.test(
        clause,
      )
    )
      return true;
    if (
      /^(?:以后|今后|从今|从今天)/u.test(clause) &&
      /(?:先|再|按|不要|别|记住|采用)/u.test(clause)
    )
      return true;
    if (
      /(?:到时候|届时).*(?:联系我|叫我)|(?:按|照).*(?:模板|原来|之前).*(?:习惯|安排)|(?:习惯|安排).*(?:按|照).*(?:模板|原来|之前)/u.test(
        clause,
      )
    )
      return true;
    if (/(?:不要|不建|不改|不能)/u.test(clause)) return false;
    return /(?:提醒我|(?:请|帮我|麻烦你).*(?:发送|发一条|发个|给我发|安排|调整|修改|保存|记录|记下|建立|建任务|创建|新增|新建|设置|设定|开启|暂停|恢复|停止|解除|采用|改成|改到)|^(?:只)?(?:记住|创建|建立|新增|新建|设置|设定|保存|安排|重新排|调整|修改|提醒|定时|定个|取消|改成|改到|开启|打开|启用|停用|暂停|恢复|开始专注)|^(?:只有今天|今天|今晚|明天|以后|每天).*(?:改成|改到|规划|整理|回顾|提醒)|(?:以后|从今|今后).*(?:简短|语气|说话|表达|称呼)|(?:以后|从今天|每天|工作日|每小时).*(?:提醒|问我|整理|回顾|规划)|(?:今天|明天|后天|每天|周[一二三四五六日天]|星期[一二三四五六日天]).*(?:有空|空闲|可以安排|留给)|(?:每隔|每)[一二三四五六七八九十\d]+个?小时.*(?:提醒|问我|检查|理解|干什么|做什么))/u.test(
      clause,
    );
  });
}
export function explicitCommitment(text: string) {
  if (discussionOnly(text)) return false;
  return !!confirmation(text) || commandRequest(text);
}

/** A single explicitly quoted report is user data, not material for paraphrasing. */
export function literalReportText(text: string): string | null {
  const values = [...text.matchAll(/(?:记为|记录为|改成|改为|更正为)\s*(?:“([^”\n]+)”|「([^」\n]+)」|『([^』\n]+)』|"([^"\n]+)")/gu)];
  if (values.length !== 1) return null; // Multiple records need their own explicit association.
  return values[0].slice(1).find((value) => value !== undefined) ?? null;
}

/** File tools need a user request to change documents; a reminder command grants no file-writing authority. */
export function documentMutationRequested(text: string) {
  if (discussionOnly(text)) return false;
  const mutation =
    /(?:创建|新建|建立|写|填|编辑|修改|更新|追加|添加|补充|改名|重命名|删除|删|恢复|整理|保存|记住|授权操作)/u;
  return (
    (mutation.test(text) &&
      /(?:\.md\b|日记|周记|月记|年记|笔记|文章|文件|模板|目录|手册|记忆|计划|安排|正文|记录|授权操作笔记)/u.test(
        text,
      )) ||
    /^(?:请|帮我)?(?:写进去|删掉它|删除它|改名|重命名|保存|恢复这|记住)/u.test(
      text.trim(),
    )
  );
}
export function requestActionTypes(text: string): string[] {
  return [
    ...new Set([
      ...(/提醒|联系我|小时|番茄|计时/u.test(text)
        ? ["create_automation", "update_automation", "start_focus"]
        : []),
      ...(/任务|安排|排一下|计划|背单词/u.test(text)
        ? [
            "create_task",
            "configure_task",
            "schedule",
            "set_planning",
            "plan_day",
          ]
        : []),
      ...(/习惯|模板/u.test(text)
        ? ["create_habit", "update_habit", "link_diary"]
        : []),
    ]),
  ];
}
export function confirmation(text: string): "all" | "latest" | "yes" | null {
  if (discussionOnly(text)) return null;
  if (/[?？]|能不能|可以吗|是不是|是否|为什么|怎么|如何|你确认/u.test(text))
    return null;
  if (
    /(?:这些|这几项|这几件|这一批|整批).*(?:都要|落地|执行|提交|确认|都建)/u.test(
      text,
    )
  )
    return "all";
  if (
    /(?:全部|所有|这[一二三四五六七八九十\d]+份|[一二三四五六七八九十\d]+份).*(?:都建|都要|提交|落地|执行|确认)|(?:确认|同意|接受).*(?:全部|所有)/u.test(
      text,
    )
  )
    return "all";
  if (
    /^(?:就|按)?(?:最后(?:确定|定稿)?的?(?:那个|那份)|刚才(?:确定|定稿)的?(?:那个|那份))[。！!\s]*$/u.test(
      text,
    )
  )
    return "latest";
  return /^(?:好|好的|可以|可以了[，,\s]*(?:写进去|执行|提交)|就这样|同意|写进去)[。！!\s]*$/u.test(
    text,
  )
    ? "yes"
    : null;
}
