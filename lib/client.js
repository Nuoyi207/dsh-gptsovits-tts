/**
 * DSH 插件（Client 侧）：右侧边栏的「语音模型」面板。
 *
 * 职责
 * - 列出 voices.json 里的音色，切换默认朗读音色、试听、移除。
 * - 用仓库里已有的 GPT / SoVITS 权重 + 一段 3~10 秒参考音频新增音色。
 * 具体合成交给 Host 插件的 /gptsovits/* 路由，再转给本机 9866 端的 python 服务。
 *
 * 只依赖 React 与主题 token（--dsw-alias-*），不 import 任何 Harness Client 包。
 */
window.__ModuleLoader__.load({
  id: 'dsh-gptsovits-tts',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const useState = React.useState
    const useEffect = React.useEffect
    const useCallback = React.useCallback
    const useRef = React.useRef

    const NS = 'gptsovits-tts'
    const KIND = 'gptsovits.voices'
    const API = '/gptsovits'
    // 与 trainer.py 的 STAGES 顺序一致，用来画训练进度上的阶段条
    const TRAIN_STEP_KEYS = ['collect', 'separate', 'slice', 'asr', 'dataset', 'train_s2', 'train_s1', 'register']
    // 零样本：不训练，直接拿预训练底模 + 3~10 秒参考音频克隆 (对应 GPT-SoVITS 官方「5 秒参考音频」的用法)
    const BASE_GPT = 'GPT_SoVITS/pretrained_models/s1v3.ckpt'
    const BASE_SOVITS = 'GPT_SoVITS/pretrained_models/v2Pro/s2Gv2ProPlus.pth'

    // ---------------------------------------------------------------- 字典
    const zh = {
      title: '语音模型',
      hint: '换一个朗读音色，或用权重 + 参考音频新增音色',
      ready: '就绪',
      notReady: '未就绪',
      isDefault: '自动朗读',
      inUse: '使用中',
      useThis: '设为朗读',
      preview: '试听',
      previewLine: '你好，现在换我来说话。',
      previewStarted: '开始试听',
      remove: '移除',
      edit: '编辑',
      editVoice: '编辑音色',
      save: '保存修改',
      updated: '修改已保存',
      editHint: '改完点「保存修改」，音色 id 不变；参考音频留空或不改就沿用原来的',
      confirmRemove: '确定移除这个音色？只会删掉配置，不动权重文件。',
      refresh: '刷新',
      stop: '停止朗读',
      stopped: '已停止朗读',
      loading: '加载中…',
      empty: '还没有音色',
      addVoice: '新增音色',
      back: '返回',
      labelName: '音色名称',
      labelNameHint: '例如：诺艾尔',
      labelGpt: 'GPT 权重（.ckpt）',
      labelSovits: 'SoVITS 权重（.pth）',
      pick: '选择…',
      refAudio: '参考音频（3~10 秒）',
      refHint: '建议 3~8 秒干净人声，这段的音色会变成新音色',
      browse: '浏览',
      asr: '识别文本',
      asrRunning: '识别中…',
      asrDone: '已填入参考文本',
      asrEmpty: '没识别出内容',
      promptText: '参考音频里的文字',
      promptHint: '要和参考音频内容一致，否则音色会飘',
      submit: '添加并启用',
      cancel: '取消',
      added: '新音色已添加并启用',
      switchedTo: '已切换：',
      needLabel: '请先填音色名称',
      needRef: '请先选参考音频',
      up: '上一级',
      drives: '盘符',
      weightsLoading: '正在读取权重列表…',
      needWeights: '请选择 GPT 与 SoVITS 权重',
      zeroShot: '零样本（不训练）',
      zeroShotHint: '只用 3~10 秒参考音频 + 一句参考文本，直接拿预置底模克隆；素材不到 1 分钟时用这个',
      useBase: '用底模',
      weightsHint: '下拉里是仓库 GPT_weights* / SoVITS_weights* 的权重；别处的文件点「浏览…」直接挑',
      external: '外部文件：',
      readAloud: '朗读',
      pauseReading: '暂停',
      resumeReading: '继续',
      readBusy: '合成中…',
      svcTitle: '合成服务',
      engineTitle: '语音引擎',
      engineMissing: '未就绪',
      engineReady: '已就绪',
      engineHint: '首次使用要先准备语音引擎（约 11.4 GB，下载一次后长期复用）。已经装过可以指定目录。',
      engineDownload: '下载并安装',
      engineUseDir: '用已有目录…',
      enginePreparing: '正在准备引擎…',
      engineDone: '引擎已就绪',
      enginePhase_download: '下载分片',
      enginePhase_verify: '校验文件',
      enginePhase_unpack: '解压中',
      engineSpeed: 'MB/s',
      svcRunning: '运行中',
      svcUnloaded: '显存已释放',
      svcStopped: '已停止',
      svcHint: '空闲到时间会释放显存（进程保留，下次朗读自动加载）；彻底关闭 DSH 后台后服务会自己退出',
      svcRestart: '重启服务',
      svcUnload: '释放显存',
      svcStop: '停止服务',
      train: '训练新音色',
      trainTitle: '一键训练音色',
      trainHint: '丢一段录音、视频或一个人声目录进来，自动分离人声、切片、识别、训练，完成后自动加进音色列表',
      trainName: '新音色名称',
      trainNameHint: '例如：小助手（中文/英文/数字）',
      trainTier: '训练轮数',
      trainTierHint: '官方默认就是 SoVITS 8 轮 / GPT 15 轮（每 4 / 5 轮存一次权重）；轮数越多越像，素材少时容易学成复读机',
      epochSovits: 'SoVITS（音色）',
      epochGpt: 'GPT（语气）',
      epochUnit: ' 轮',
      trainSource: '素材',
      trainSourceHint: '录音/视频/人声 wav 都行；也可以直接选一个目录',
      trainPick: '选文件或目录',
      pickHere: '用这个目录',
      trainRecord: '录音',
      trainRecording: '录音中…再点一次停止',
      trainRecorded: '录音已加入素材',
      trainNoMic: '拿不到麦克风（或浏览器不支持录音），改用手选文件吧',
      trainSeparate: '自动分离人声（素材里有伴奏时勾上）',
      refDrop: '也可以把音频文件拖到这一块（自动填入路径）',
      trainDrop: '也可以把文件直接拖到这里（可多选）',
      trainDropOn: '松手就加入素材',
      trainDropped: '拖入的文件已加入素材',
      trainAudio: '有效语音',
      trainMaterial: '已选素材约',
      trainMaterialUnit: ' 秒（切片+识别后会略少）',
      trainMaterialLow: '不够 60 秒会被拦下，建议再多选几段',
      trainForce: '仍要训练（效果会差）',
      trainForceHint: '这段素材确实偏短，硬训出来的音色会不稳，试听后再决定用不用',
      trainUploading: '正在读入拖入的文件…',
      trainStart: '开始训练',
      trainCancel: '取消训练',
      trainCanceling: '正在停止…',
      trainRunning: '训练中',
      trainElapsed: '已用',
      unitMinute: '分',
      unitSecond: '秒',
      trainDone: '训练完成',
      trainFailed: '训练失败',
      trainNeedName: '先填个音色名称',
      trainNeedFiles: '先加一段素材',
      trainLog: '训练日志',
      logLatest: '跳到最新',
      restarting: '重启中…',
      svcRestarted: '服务已重启',
      svcFreed: '显存已释放，下次合成会自动加载',
      svcIdle: '空闲释放显存',
      svcIdleSaved: '释放时间已保存',
      idleNever: '从不',
      idleMinute: '分钟',
      confirmStopSvc: '停止服务后，下一次朗读会自动重启它（冷启动约 20 秒）。确定？',
      tabSynth: '合成',
      tabTrain: '训练',
      tabService: '服务',
      voiceSection: '音色',
      noVoice: '还没有音色',
      previewPick: '试听所选',
      autoFree: '空闲自动释放显存',
      autoFreeOn: '上次合成后 ',
      autoFreeOff: '不自动释放（一直占着显存）',
      stopReading: '停止朗读',
      svcUptime: '运行时长',
      svcPid: '进程',
      svcVram: '显存',
    }
    const en = {
      title: 'Voice models',
      hint: 'Switch the reading voice, or add one from weights plus a reference clip',
      ready: 'ready',
      notReady: 'offline',
      isDefault: 'auto-read',
      inUse: 'in use',
      useThis: 'set as reader',
      preview: 'preview',
      previewLine: 'Hello, this is the new voice speaking.',
      previewStarted: 'previewing',
      remove: 'remove',
      edit: 'edit',
      editVoice: 'Edit voice',
      save: 'save changes',
      updated: 'changes saved',
      editHint: 'Hit save changes — the voice keeps its id; leave the reference audio untouched to keep the current one',
      confirmRemove: 'Remove this voice? Only the config entry is deleted, weight files stay.',
      refresh: 'refresh',
      stop: 'stop',
      stopped: 'stopped',
      loading: 'loading…',
      empty: 'no voices yet',
      addVoice: 'add voice',
      back: 'back',
      labelName: 'Voice name',
      labelNameHint: 'e.g. Noelle',
      labelGpt: 'GPT weights (.ckpt)',
      labelSovits: 'SoVITS weights (.pth)',
      pick: 'choose…',
      refAudio: 'Reference audio (3–10 s)',
      refHint: '3–8 s of clean speech; its timbre becomes the new voice',
      browse: 'browse',
      asr: 'transcribe',
      asrRunning: 'transcribing…',
      asrDone: 'transcript filled in',
      asrEmpty: 'nothing recognised',
      promptText: 'Words in the reference clip',
      promptHint: 'Must match the clip, otherwise the voice drifts',
      submit: 'add and use',
      cancel: 'cancel',
      added: 'added and activated',
      switchedTo: 'switched to ',
      needLabel: 'enter a voice name first',
      needRef: 'pick a reference audio first',
      up: 'up',
      drives: 'drives',
      weightsLoading: 'reading weight list…',
      needWeights: 'choose GPT and SoVITS weights',
      zeroShot: 'zero-shot (no training)',
      zeroShotHint: 'Clone from a 3~10 s reference clip with the built-in base model; use this when you have under a minute of audio',
      useBase: 'use base model',
      weightsHint: 'The lists come from GPT_weights* / SoVITS_weights* in the repo; use browse to pick a file anywhere else',
      external: 'external file: ',
      readAloud: 'read',
      pauseReading: 'pause',
      resumeReading: 'resume',
      readBusy: 'synthesizing…',
      svcTitle: 'Service',
      engineTitle: 'Engine',
      engineMissing: 'not ready',
      engineReady: 'ready',
      engineHint: 'First run needs the speech engine (~11.4 GB, downloaded once). You can also point at an existing install.',
      engineDownload: 'Download',
      engineUseDir: 'Use existing folder…',
      enginePreparing: 'Preparing engine…',
      engineDone: 'Engine ready',
      enginePhase_download: 'downloading',
      enginePhase_verify: 'verifying',
      enginePhase_unpack: 'unpacking',
      engineSpeed: 'MB/s',
      svcRunning: 'running',
      svcUnloaded: 'VRAM freed',
      svcStopped: 'stopped',
      svcHint: 'Frees VRAM after the idle timeout (process stays, next read reloads it); closing DSH fully also stops it',
      svcRestart: 'restart service',
      svcUnload: 'free VRAM',
      svcStop: 'stop service',
      train: 'train voice',
      trainTitle: 'One-click voice training',
      trainHint: 'Drop in a recording, a video or a folder of clean vocals — it separates, slices, transcribes and trains, then adds the voice to the list',
      trainName: 'New voice name',
      trainNameHint: 'e.g. assistant (letters, digits, CJK)',
      trainTier: 'Epochs',
      trainTierHint: 'Official defaults: 8 epochs for SoVITS and 15 for GPT, saving every 4 / 5 epochs; more epochs fit better but overfit on small datasets',
      epochSovits: 'SoVITS (timbre)',
      epochGpt: 'GPT (prosody)',
      epochUnit: ' ep',
      trainSource: 'Material',
      trainSourceHint: 'Recordings, videos or clean vocal wavs; a whole folder works too',
      trainPick: 'pick files or folder',
      pickHere: 'use this folder',
      trainRecord: 'record',
      trainRecording: 'recording… click again to stop',
      trainRecorded: 'Recording added',
      trainNoMic: 'No microphone (or recording unsupported); pick a file instead',
      trainSeparate: 'separate vocals automatically (tick when the material has instrumentation)',
      refDrop: 'or drop an audio file here to fill the path',
      trainDrop: 'or drop files right here (multiple allowed)',
      trainDropOn: 'release to add',
      trainDropped: 'Dropped files added',
      trainAudio: 'usable speech',
      trainMaterial: 'selected material ≈',
      trainMaterialUnit: ' s (a bit less after slicing)',
      trainMaterialLow: 'under 60 s will be rejected — pick more clips',
      trainForce: 'train anyway (worse quality)',
      trainForceHint: 'The material is short; the cloned voice will be unstable. Listen before keeping it.',
      trainUploading: 'reading dropped files…',
      trainStart: 'start training',
      trainCancel: 'cancel training',
      trainCanceling: 'stopping…',
      trainRunning: 'training',
      trainElapsed: 'elapsed',
      unitMinute: 'm',
      unitSecond: 's',
      trainDone: 'training done',
      trainFailed: 'training failed',
      trainNeedName: 'give the voice a name first',
      trainNeedFiles: 'add some material first',
      trainLog: 'training log',
      restarting: 'restarting…',
      svcRestarted: 'service restarted',
      svcFreed: 'VRAM freed; next synthesis reloads it',
      svcIdle: 'free VRAM when idle for',
      svcIdleSaved: 'idle timeout saved',
      idleNever: 'never',
      idleMinute: 'min',
      confirmStopSvc: 'After stopping, the next read restarts the service (about 20 s cold start). Continue?',
      tabSynth: 'synthesis',
      tabTrain: 'training',
      tabService: 'service',
      voiceSection: 'voices',
      noVoice: 'no voice yet',
      previewPick: 'preview selected',
      autoFree: 'Free VRAM when idle',
      autoFreeOn: 'after ',
      autoFreeOff: 'never (keeps VRAM)',
      stopReading: 'stop reading',
      svcUptime: 'uptime',
      svcPid: 'pid',
      svcVram: 'vram',
    }

    // ---------------------------------------------------------------- 样式
    const C = {
      text: 'var(--dsw-alias-label-primary, inherit)',
      sub: 'var(--dsw-alias-label-secondary, #9aa4b2)',
      dim: 'var(--dsw-alias-label-tertiary, #8b939e)',
      border: 'var(--dsw-alias-border-l2, rgba(127,127,127,.28))',
      borderStrong: 'var(--dsw-alias-border-l3, rgba(127,127,127,.4))',
      panel: 'var(--dsw-alias-bg-layer-1, rgba(127,127,127,.07))',
      panel2: 'var(--dsw-alias-bg-layer-2, rgba(127,127,127,.12))',
      base: 'var(--dsw-alias-bg-base, transparent)',
      primary: 'var(--dsw-alias-button-primary-fill, #2f6fed)',
      primaryHover: 'var(--dsw-alias-button-primary-hover, #4a82f5)',
      hover: 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.14))',
      danger: 'var(--dsw-alias-label-danger, #e5484d)',
      ok: 'var(--dsw-alias-label-success, #3fb950)',
      warn: 'var(--dsw-alias-label-warning, #d29922)',
      inverted: 'var(--dsw-alias-label-primary-inverted, #fff)',
      baseSolid: 'var(--dsw-alias-bg-base, #14181f)',
      knobLight: 'var(--dsw-alias-bg-layer-3, #cfd6df)',
    }

    const S = {
      external: {
        color: 'var(--dsw-alias-label-tertiary, #8b939e)',
        fontSize: '10.5px',
        wordBreak: 'break-all',
      },
      root: {
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
        height: '100%',
        overflowY: 'auto',
        boxSizing: 'border-box',
        padding: '12px 12px 24px',
        color: C.text,
        fontSize: '12px',
        lineHeight: '1.5',
      },
      header: { display: 'flex', flexDirection: 'column', gap: '3px', paddingBottom: '2px' },
      titleRow: { display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 },
      name: { fontSize: '13px', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      meta: { color: C.dim, fontSize: '10px', wordBreak: 'break-all', lineHeight: '1.35' },
      card: {
        display: 'flex',
        flexDirection: 'column',
        gap: '5px',
        padding: '9px 10px',
        borderRadius: '8px',
        border: '1px solid ' + C.border,
        background: C.panel,
      },
      quote: {
        color: C.sub,
        fontSize: '11px',
        background: C.panel2,
        borderRadius: '5px',
        padding: '3px 6px',
        display: '-webkit-box',
        WebkitLineClamp: 2,
        WebkitBoxOrient: 'vertical',
        overflow: 'hidden',
      },
      actions: { display: 'flex', gap: '5px', flexWrap: 'wrap', marginTop: '1px' },
      input: {
        width: '100%',
        boxSizing: 'border-box',
        font: 'inherit',
        fontSize: '12px',
        padding: '5px 7px',
        borderRadius: '6px',
        border: '1px solid ' + C.borderStrong,
        background: C.base,
        color: C.text,
        outline: 'none',
      },
      err: { color: C.danger, fontSize: '11px', whiteSpace: 'pre-wrap' },
      ok: { color: C.ok, fontSize: '11px' },
      list: { display: 'flex', flexDirection: 'column', gap: '8px' },
      rowGap: { display: 'flex', gap: '6px', alignItems: 'center' },
      grow: { flex: 1, minWidth: 0 },
      tag: { fontSize: '10px', color: C.dim, border: '1px solid ' + C.border, borderRadius: '4px', padding: '0 4px' },
      bar: { height: '6px', borderRadius: '999px', background: C.panel2, overflow: 'hidden' },
      barFill: { height: '100%', borderRadius: '999px', background: C.primary, transition: 'width .3s' },
      steps: { display: 'flex', flexWrap: 'wrap', gap: '4px', marginTop: '2px' },
      stepChip: {
        fontSize: '10px',
        lineHeight: '1.5',
        padding: '0 5px',
        borderRadius: '4px',
        border: '1px solid ' + C.border,
        whiteSpace: 'nowrap',
      },
      hidden: { display: 'none' },
      drop: {
        marginTop: '2px',
        padding: '9px 8px',
        borderRadius: '8px',
        border: '1px dashed ' + C.borderStrong,
        color: C.dim,
        fontSize: '10.5px',
        textAlign: 'center',
        lineHeight: '1.5',
        cursor: 'default',
      },
      dropOn: {
        borderColor: C.primary,
        color: C.text,
        background: C.hover,
      },
      log: {
        margin: 0,
        maxHeight: '190px',
        overflow: 'auto',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-all',
        fontSize: '10.5px',
        lineHeight: '1.45',
        color: C.sub,
        background: C.panel2,
        borderRadius: '6px',
        padding: '6px 7px',
      },
      browseBox: {
        display: 'flex',
        flexDirection: 'column',
        gap: '3px',
        maxHeight: '190px',
        overflowY: 'auto',
        border: '1px solid ' + C.border,
        borderRadius: '6px',
        padding: '5px',
        background: C.base,
      },
      link: { cursor: 'pointer', color: 'inherit', fontSize: '11px', padding: '1px 2px', borderRadius: '4px' },
      head: {
        display: 'flex',
        alignItems: 'center',
        gap: '9px',
        padding: '9px 10px',
        borderRadius: '10px',
        border: '1px solid ' + C.border,
        background: C.panel,
      },
      avatar: {
        flex: '0 0 auto',
        width: '34px',
        height: '34px',
        borderRadius: '50%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: '14px',
        fontWeight: 600,
        color: '#fff',
        background: 'linear-gradient(135deg,' + C.primary + ',#7aa2ff)',
      },
      headText: { display: 'flex', flexDirection: 'column', gap: '1px', minWidth: 0, flex: 1 },
      headName: { fontSize: '12.5px', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      status: { fontSize: '10.5px', color: C.dim },
      statusLive: { fontSize: '10.5px', color: C.ok },
      fullRow: { display: 'flex', gap: '6px', alignItems: 'center' },
      select: {
        flex: 1,
        minWidth: 0,
        font: 'inherit',
        fontSize: '12px',
        padding: '6px 8px',
        borderRadius: '7px',
        border: '1px solid ' + C.borderStrong,
        background: C.base,
        color: C.text,
        outline: 'none',
      },
      seg: { display: 'flex', gap: '2px', padding: '2px', borderRadius: '8px', border: '1px solid ' + C.border, background: C.panel },
      segItem: {
        flex: 1,
        textAlign: 'center',
        padding: '5px 0',
        borderRadius: '6px',
        fontSize: '11.5px',
        color: C.dim,
        cursor: 'pointer',
        userSelect: 'none',
        background: 'transparent',
      },
      segItemOn: { background: C.panel2, color: C.text, fontWeight: 600 },
      sliderRow: { display: 'flex', flexDirection: 'column', gap: '5px', marginBottom: '10px' },
      sliderHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' },
      sliderLabel: { fontSize: '11.5px', color: C.text },
      sliderSteppers: { display: 'flex', alignItems: 'center', gap: '4px' },
      sliderValue: { fontSize: '11px', color: C.dim, minWidth: '42px', textAlign: 'center', fontVariantNumeric: 'tabular-nums' },
      stepBtn: {
        width: '18px',
        height: '18px',
        lineHeight: '16px',
        textAlign: 'center',
        padding: 0,
        borderRadius: '5px',
        border: '1px solid ' + C.border,
        background: C.panel2,
        color: C.text,
        fontSize: '12px',
        cursor: 'pointer',
      },
      track: { position: 'relative', height: '16px', cursor: 'pointer', touchAction: 'none' },
      trackLine: {
        position: 'absolute',
        left: 0,
        right: 0,
        top: '50%',
        height: '4px',
        marginTop: '-2px',
        borderRadius: '2px',
        background: C.border,
      },
      trackFill: {
        position: 'absolute',
        left: 0,
        top: '50%',
        height: '4px',
        marginTop: '-2px',
        borderRadius: '2px',
        background: C.primary,
      },
      sliderKnob: {
        position: 'absolute',
        top: '50%',
        width: '12px',
        height: '12px',
        borderRadius: '50%',
        background: '#fff',
        border: '2px solid ' + C.primary,
        boxSizing: 'border-box',
        transform: 'translate(-50%, -50%)',
      },
      toggleRow: {
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        padding: '8px 10px',
        borderRadius: '9px',
        border: '1px solid ' + C.border,
        background: C.panel,
      },
      switch: { flex: '0 0 auto', width: '34px', height: '18px', borderRadius: '999px', position: 'relative', cursor: 'pointer', transition: 'background .2s' },
      switchKnob: { position: 'absolute', top: '2px', width: '14px', height: '14px', borderRadius: '50%', background: '#fff', transition: 'left .2s' },
      sectionBar: { display: 'flex', alignItems: 'center', gap: '6px' },
      sectionTitle: { fontSize: '11px', fontWeight: 600, color: C.sub, letterSpacing: '.04em' },
      grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(164px,1fr))', gap: '7px' },
      vcard: {
        display: 'flex',
        flexDirection: 'column',
        gap: '5px',
        padding: '9px',
        borderRadius: '9px',
        border: '1px solid ' + C.border,
        background: C.panel,
      },
      vhead: { display: 'flex', alignItems: 'center', gap: '7px', minWidth: 0 },
      vavatar: {
        flex: '0 0 auto',
        width: '24px',
        height: '24px',
        borderRadius: '50%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: '11px',
        fontWeight: 600,
        color: '#fff',
        background: 'linear-gradient(135deg,' + C.primary + ',#7aa2ff)',
      },
      iconBtn: {
        appearance: 'none',
        font: 'inherit',
        fontSize: '12px',
        lineHeight: 1,
        padding: '2px 5px',
        borderRadius: '5px',
        border: '1px solid transparent',
        background: 'transparent',
        color: C.dim,
        cursor: 'pointer',
      },
      svcRow: { display: 'flex', alignItems: 'center', gap: '6px' },
      readBtn: {
        appearance: 'none',
        font: 'inherit',
        fontSize: '11px',
        lineHeight: '1.2',
        display: 'inline-flex',
        alignItems: 'center',
        padding: '3px 6px',
        borderRadius: '6px',
        border: 'none',
        background: 'transparent',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      },
    }

    function Seg(props) {
      const items = Array.isArray(props.items) ? props.items : []
      return h(
        'div',
        { style: S.seg },
        ...items.map((item) =>
          h(
            'button',
            {
              type: 'button',
              key: item.value,
              style: Object.assign({}, props.value === item.value ? Object.assign({}, S.segItem, S.segItemOn) : S.segItem, { appearance: 'none', border: 'none', font: 'inherit' }),
              onClick: () => {
                if (typeof props.onChange === 'function') props.onChange(item.value)
              },
            },
            item.label,
          ),
        ),
      )
    }

    function Slider(props) {
      const min = Number.isFinite(props.min) ? props.min : 1
      const max = Number.isFinite(props.max) ? props.max : 100
      const step = Number.isFinite(props.step) && props.step > 0 ? props.step : 1
      const value = Math.min(max, Math.max(min, Number(props.value) || min))
      const pct = max === min ? 0 : ((value - min) / (max - min)) * 100
      const disabled = props.disabled === true
      const emit = (next) => {
        if (disabled) return
        const clamped = Math.min(max, Math.max(min, Math.round(next / step) * step))
        if (clamped !== value && typeof props.onChange === 'function') props.onChange(clamped)
      }
      const fromPointer = (event) => {
        const el = event && event.currentTarget
        if (!el || typeof el.getBoundingClientRect !== 'function') return
        const rect = el.getBoundingClientRect()
        if (!rect || !rect.width) return
        emit(min + ((event.clientX - rect.left) / rect.width) * (max - min))
      }
      return h(
        'div',
        { style: S.sliderRow },
        h(
          'div',
          { style: S.sliderHead },
          h('span', { style: S.sliderLabel }, props.label || ''),
          h(
            'span',
            { style: S.sliderSteppers },
            h(
              'button',
              {
                type: 'button',
                style: Object.assign({}, S.stepBtn, disabled ? { opacity: 0.4 } : null),
                onClick: () => emit(value - step),
              },
              '−',
            ),
            h('span', { style: S.sliderValue }, String(value) + (props.suffix || '')),
            h(
              'button',
              {
                type: 'button',
                style: Object.assign({}, S.stepBtn, disabled ? { opacity: 0.4 } : null),
                onClick: () => emit(value + step),
              },
              '＋',
            ),
          ),
        ),
        h(
          'div',
          {
            style: Object.assign({}, S.track, disabled ? { opacity: 0.5 } : null),
            onClick: fromPointer,
            onPointerDown: (event) => {
              if (event && event.currentTarget && typeof event.currentTarget.setPointerCapture === 'function') {
                try {
                  event.currentTarget.setPointerCapture(event.pointerId)
                } catch (error) {
                  /* 拖拽捕获失败就退化成点选 */
                }
              }
              fromPointer(event)
            },
            onPointerMove: (event) => {
              if (!event || event.buttons !== 1) return
              fromPointer(event)
            },
          },
          h('div', { style: S.trackLine }),
          h('div', { style: Object.assign({}, S.trackFill, { width: pct + '%' }) }),
          h('div', { style: Object.assign({}, S.sliderKnob, { left: pct + '%' }) }),
        ),
      )
    }

    function Switch(props) {
      const on = props.on === true
      return h(
        'button',
        {
          type: 'button',
          style: Object.assign({}, S.switch, {
            background: on ? C.primary : C.panel2,
            border: '1px solid ' + (on ? C.primary : C.borderStrong),
            opacity: props.disabled ? 0.45 : 1,
            cursor: props.disabled ? 'default' : 'pointer',
          }),
          onClick: () => {
            if (props.disabled) return
            if (typeof props.onToggle === 'function') props.onToggle()
          },
        },
        h('div', {
          style: Object.assign({}, S.switchKnob, {
            left: on ? '17px' : '2px',
            // 照 DSH 原生开关：开＝浅色轨道 + 深色滑块；关＝深色轨道 + 浅灰滑块
            background: on ? C.baseSolid : C.knobLight,
            boxShadow: 'none',
          }),
        }),
      )
    }

    function Section(props) {
      return h(
        'div',
        { style: S.card },
        h(
          'div',
          { style: S.sectionBar },
          h('span', { style: S.sectionTitle }, props.title),
          h('div', { style: S.grow }),
          props.extra === undefined ? null : props.extra,
        ),
        props.children,
      )
    }
    function Avatar(props) {
      const label = String(props.label || '?')
      return h('div', { style: props.small ? S.vavatar : S.avatar }, Array.from(label)[0] || '?')
    }

    function VoiceCard(props) {
      const voice = props.voice
      const t = props.t
      const gptName = String(voice.gpt || '').split('/').pop()
      const sovitsName = String(voice.sovits || '').split('/').pop()
      return h(
        'div',
        { style: S.vcard },
        h(
          'div',
          { style: S.vhead },
          h(Avatar, { small: true, label: voice.label }),
          h(
            'div',
            { style: S.headText },
            h('div', { style: S.headName }, voice.label),
            h(
              'div',
              { style: Object.assign({}, S.status, { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }) },
              voice.default ? t('isDefault') : voice.version || '',
            ),
          ),
          voice.default ? h(Chip, { tone: 'ok' }, t('inUse')) : null,
        ),
        h(
          'div',
          {
            style: Object.assign({}, S.meta, { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', wordBreak: 'normal' }),
            title: gptName + ' / ' + sovitsName,
          },
          gptName + ' · ' + sovitsName,
        ),
        voice.prompt_text ? h('div', { style: S.quote }, '“' + voice.prompt_text + '”') : null,
        h(
          'div',
          { style: S.actions },
          h(
            Btn,
            {
              primary: !voice.default,
              small: true,
              disabled: voice.default === true || props.busy === 'switch:' + voice.id,
              onClick: () => props.onSwitch(voice),
            },
            voice.default ? t('inUse') : t('useThis'),
          ),
          h(Btn, { small: true, disabled: props.busy === 'preview:' + voice.id, onClick: () => props.onPreview(voice) }, t('preview')),
        ),
        h(
          'div',
          { style: S.actions },
          h(Btn, { small: true, disabled: props.busy === 'weights' || props.busy === 'add', onClick: () => props.onEdit(voice) }, t('edit')),
          voice.default
            ? null
            : h(Btn, { small: true, danger: true, disabled: props.busy === 'remove:' + voice.id, onClick: () => props.onRemove(voice) }, t('remove')),
        ),
      )
    }
    // ---------------------------------------------------------------- HTTP
    async function api(path, options = {}) {
      const body = options.body
      const raw = options.raw === true
      const headers = body === undefined ? undefined : raw ? undefined : { 'content-type': 'application/json; charset=utf-8' }
      const response = await fetch(API + path, {
        method: options.method || (body === undefined ? 'GET' : 'POST'),
        headers,
        body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
      })
      const text = await response.text()
      let data = {}
      if (text !== '') {
        try {
          data = JSON.parse(text)
        } catch {
          data = { detail: text }
        }
      }
      if (!response.ok) {
        const detail = data && (data.detail || data.error)
        throw new Error(typeof detail === 'string' && detail !== '' ? detail : 'HTTP ' + response.status)
      }
      return data
    }

    function describe(error) {
      if (error === null || error === undefined) return ''
      if (typeof error === 'string') return error
      return String(error.message || error)
    }

    function joinPath(dir, name) {
      if (!dir) return name
      return /[\\/]$/.test(dir) ? dir + name : dir + '\\' + name
    }

    /** 从一个 GPT 权重猜测配套的 SoVITS：取文件名里第一个词（诺艾尔-e15 → 诺艾尔）。 */
    function guessPair(gptPath, list) {
      if (!gptPath || !Array.isArray(list) || list.length === 0) return ''
      const stem = String(gptPath).split('/').pop().replace(/\.[^.]+$/, '')
      const token = stem.split(/[-_]/)[0].toLowerCase()
      if (token === '') return ''
      let best = ''
      let bestScore = 0
      for (const item of list) {
        const name = String(item.name || '').replace(/\.[^.]+$/, '').toLowerCase()
        if (!name.includes(token)) continue
        const score = token.length - Math.abs(name.length - stem.length) / 1000
        if (score > bestScore) {
          bestScore = score
          best = item.path
        }
      }
      return best
    }

    // ---------------------------------------------------------------- 消息操作栏：朗读 / 暂停
    // 播报状态是全局的（服务端同一时间只播一条），多个消息上的按钮共用一个订阅源。
    // state 只是「有没有在播」；owner 记录「这条消息是不是正在播的那一条」，只有 owner 的按钮才显示暂停。
    const playback = { state: 'idle', index: 0, chunks: 0, seq: 0, owner: null, listeners: new Set() }
    let poller = null
    let lastSync = 0

    function setPlayback(patch) {
      let changed = false
      for (const key of Object.keys(patch)) {
        if (playback[key] !== patch[key]) {
          playback[key] = patch[key]
          changed = true
        }
      }
      if (!changed) return
      for (const fn of playback.listeners) {
        try {
          fn()
        } catch (error) {
          console.error('[gptsovits-tts] 播报状态订阅出错', error)
        }
      }
    }

    async function syncPlayback() {
      // 一条回复里每个消息都有一个朗读按钮，同时挂载时只让第一个去问服务端
      const now = Date.now()
      if (now - lastSync < 800) return
      lastSync = now
      try {
        const data = await api('/status', { method: 'GET' })
        const state = data.state === 'playing' ? 'playing' : data.state === 'paused' ? 'paused' : 'idle'
        const seq = Number(data.seq || 0)
        if (state === 'idle') {
          setPlayback({ state, index: 0, chunks: 0, seq, owner: null })
          return
        }
        // seq <= 0 表示服务端正在切换到新的一条（旧 seq 已标废），这轮别动归属，等下一轮
        if (seq <= 0) return
        // 服务端在播的 seq 已经不是我们记的那一条（自动朗读 / 别处触发）→ 归属未知，全部按钮回到「朗读」
        const owner = playback.owner !== null && seq === playback.seq ? playback.owner : null
        setPlayback({ state, index: Number(data.index || 0), chunks: Number(data.chunks || 0), seq, owner })
      } catch {
        setPlayback({ state: 'idle', owner: null })
      }
    }

    /** 订阅播报状态；第一个订阅者负责起一个 1.5s 的轮询（自动朗读也在里面）。 */
    function usePlayback() {
      const [, bump] = useState(0)
      useEffect(() => {
        let alive = true
        const notify = () => {
          if (alive) bump((n) => n + 1)
        }
        playback.listeners.add(notify)
        if (poller === null) {
          poller = setInterval(() => void syncPlayback(), 1500)
        }
        void syncPlayback()
        return () => {
          alive = false
          playback.listeners.delete(notify)
          if (playback.listeners.size === 0 && poller !== null) {
            clearInterval(poller)
            poller = null
          }
        }
      }, [])
      return playback
    }

    function messageTextOf(legacy, messageId) {
      const nodes = legacy && Array.isArray(legacy.nodes) ? legacy.nodes : []
      for (const node of nodes) {
        if (!node || node.kind !== 'assistant' || node.messageId !== messageId) continue
        const blocks = Array.isArray(node.blocks) ? node.blocks : []
        return blocks
          .filter((block) => block && block.kind === 'text' && typeof block.text === 'string')
          .map((block) => block.text)
          .join('\n\n')
      }
      return ''
    }

    // 行内代码只脱反引号、内容照念：`client.js: lastSync is not defined` 这种不能被吞掉。
    // 在 Client 先做一遍，Host 侧的清洗（会整段删掉行内代码）就看不到反引号了。
    function plainForSpeech(text) {
      return String(text ?? '')
        .replace(/`([^`\n]+)`/g, ' $1 ')
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/[ \t]+([，。！？；：、）」』】…])/g, '$1')
        .replace(/([（「『【])[ \t]+/g, '$1')
        .trim()
    }

    function ReadGlyph(props) {
      const common = {
        width: 12,
        height: 12,
        viewBox: '0 0 16 16',
        'aria-hidden': true,
        style: { display: 'block' },
      }
      if (props.kind === 'pause') {
        return h(
          'svg',
          common,
          h('rect', { x: 4, y: 3, width: 3, height: 10, rx: 1, fill: 'currentColor' }),
          h('rect', { x: 9, y: 3, width: 3, height: 10, rx: 1, fill: 'currentColor' }),
        )
      }
      return h('svg', common, h('path', { d: 'M5 3.2 12.4 8 5 12.8Z', fill: 'currentColor' }))
    }

    function ReadButton(props) {
      const t = props.t
      const useChat = props.useChat
      // 注意：hook 顺序必须稳定，useChat 缺失时退化成恒返回 null 的普通函数。
      const legacy = typeof useChat === 'function' ? useChat((chat) => (chat && chat.legacy) || null) : null
      const state = usePlayback()
      const [busy, setBusy] = useState(false)
      const [hover, setHover] = useState(false)
      const text = messageTextOf(legacy, props.messageId)

      if (text === '') return null

      // 只有「正在播的那条消息」才显示暂停/继续，其它消息保持「朗读」
      const mine = state.owner !== null && state.owner === props.messageId
      const playing = mine && state.state === 'playing'
      const paused = mine && state.state === 'paused'
      const label = busy
        ? t('readBusy')
        : playing
          ? t('pauseReading')
          : paused
            ? t('resumeReading')
            : t('readAloud')
      const style = Object.assign({}, S.readBtn, {
        color: playing ? C.primary : C.sub,
        background: hover && !busy ? C.hover : 'transparent',
        opacity: busy ? 0.6 : 1,
        cursor: busy ? 'default' : 'pointer',
      })

      async function onClick() {
        if (busy) return
        try {
          if (playing) {
            await api('/pause', { method: 'POST' })
            setPlayback({ state: 'paused' })
            return
          }
          if (paused) {
            await api('/resume', { method: 'POST' })
            setPlayback({ state: 'playing' })
            return
          }
          setBusy(true)
          // 换一条消息时先把正在播的那条停掉，否则服务端会把旧的那条接着播下去
          if (state.state !== 'idle') {
            try {
              await api('/stop', { method: 'POST' })
            } catch (error) {
              console.error('[gptsovits-tts] 停止上一条朗读失败', error)
            }
          }
          const result = await api('/speak', { body: { text: plainForSpeech(text) } })
          setPlayback({ state: 'playing', owner: props.messageId, seq: Number((result && result.seq) || 0) })
        } catch (error) {
          console.error('[gptsovits-tts] 朗读失败', error)
        } finally {
          setBusy(false)
        }
      }

      return h(
        'button',
        {
          type: 'button',
          title: label,
          disabled: busy,
          style,
          onClick: () => void onClick(),
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
        },
        h(ReadGlyph, { kind: playing ? 'pause' : 'play' }),
        h('span', { style: { marginLeft: '4px' } }, label),
      )
    }

    // ---------------------------------------------------------------- 基础控件
    function Btn(props) {
      const [hover, setHover] = useState(false)
      const disabled = props.disabled === true
      const primary = props.primary === true
      const danger = props.danger === true
      const small = props.small === true
      const style = {
        appearance: 'none',
        font: 'inherit',
        fontSize: small ? '10.5px' : '11.5px',
        lineHeight: '1.2',
        padding: small ? '2px 6px' : '4px 9px',
        borderRadius: small ? '5px' : '6px',
        border: '1px solid ' + (primary ? 'transparent' : C.borderStrong),
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.45 : 1,
        whiteSpace: 'nowrap',
        background: primary ? C.primary : 'transparent',
        color: primary ? C.inverted : danger ? C.danger : C.text,
      }
      if (!disabled && hover) style.background = primary ? C.primaryHover : C.hover
      return h(
        'button',
        {
          type: 'button',
          disabled,
          title: props.title,
          style,
          onClick: disabled ? undefined : props.onClick,
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
        },
        props.children,
      )
    }

    function Chip(props) {
      const color = props.tone === 'ok' ? C.ok : props.tone === 'warn' ? C.warn : C.sub
      return h(
        'span',
        {
          style: {
            fontSize: '10px',
            lineHeight: '1.4',
            padding: '0 5px',
            borderRadius: '999px',
            border: '1px solid ' + color,
            color,
            whiteSpace: 'nowrap',
          },
        },
        props.children,
      )
    }

    function Field(props) {
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '3px' } },
        h('div', { style: { color: C.sub, fontSize: '11px' } }, props.label),
        props.children,
        props.hint ? h('div', { style: { color: C.dim, fontSize: '10.5px' } }, props.hint) : null,
      )
    }

    function Options(props) {
      const list = props.list || []
      const empty = h('option', { value: '' }, props.placeholder || '')
      return [empty].concat(
        list.map((item) =>
          h('option', { key: item.path, value: item.path }, item.path + '  (' + item.size_mb + 'MB)'),
        ),
      )
    }

    // ---------------------------------------------------------------- 新增音色表单
    function AddForm(props) {
      const { t, weights, form, setForm, busy, onBrowse, onAsr, onSubmit, onCancel, browse, asrState, onPickWeight, onDropAudio } = props
      // 这里一个 hook 都不放：先渲染 loading、后渲染表单，hooks 数量一变就会命中 React #310
      if (!weights) {
        return h('div', { style: S.meta }, busy === 'weights' ? t('weightsLoading') : t('loading'))
      }
      const gptList = weights.gpt || []
      const sovitsList = weights.sovits || []
      const setGpt = (value) => {
        setForm((current) => {
          const next = Object.assign({}, current, { gpt: value })
          if (current.sovits === '' && value !== '') next.sovits = guessPair(value, sovitsList)
          return next
        })
      }
      return h(
        'div',
        { style: S.card },
        h(
          'div',
          { style: S.toggleRow },
          h(
            'div',
            { style: S.grow },
            h('div', { style: S.headName }, t('zeroShot')),
            h('div', { style: S.status }, t('zeroShotHint')),
          ),
          h(Btn, {
            disabled: busy === 'weights',
            onClick: () =>
              setForm(
                Object.assign({}, form, {
                  gpt: BASE_GPT,
                  sovits: BASE_SOVITS,
                }),
              ),
          }, t('useBase')),
        ),
        h(
          Field,
          { label: t('labelName') },
          h('input', {
            style: S.input,
            value: form.label,
            placeholder: t('labelNameHint'),
            onChange: (event) => setForm(Object.assign({}, form, { label: event.target.value })),
          }),
        ),
        h(
          Field,
          { label: t('labelGpt'), hint: t('weightsHint') },
          h(
            'div',
            { style: S.rowGap },
            h(
              'select',
              {
                style: Object.assign({}, S.input, { flex: 1 }),
                value: form.gpt,
                onChange: (event) => setGpt(event.target.value),
              },
              h(Options, { list: gptList, placeholder: t('pick') }),
            ),
            h(Btn, { onClick: () => onPickWeight('gpt'), disabled: busy === 'browse' }, t('browse')),
          ),
          form.gpt !== '' && !gptList.some((item) => item.path === form.gpt)
            ? h('div', { style: S.external }, t('external') + form.gpt)
            : null,
        ),
        h(
          Field,
          { label: t('labelSovits') },
          h(
            'div',
            { style: S.rowGap },
            h(
              'select',
              {
                style: Object.assign({}, S.input, { flex: 1 }),
                value: form.sovits,
                onChange: (event) => setForm(Object.assign({}, form, { sovits: event.target.value })),
              },
              h(Options, { list: sovitsList, placeholder: t('pick') }),
            ),
            h(Btn, { onClick: () => onPickWeight('sovits'), disabled: busy === 'browse' }, t('browse')),
          ),
          form.sovits !== '' && !sovitsList.some((item) => item.path === form.sovits)
            ? h('div', { style: S.external }, t('external') + form.sovits)
            : null,
        ),
        h(
          Field,
          { label: t('refAudio'), hint: t('refHint') },
          h(
            'div',
            {
              // 用静态样式：这里不引 state，避免 hooks 数量随渲染分支变化
              style: S.drop,
              onDragOver: (event) => {
                if (event && typeof event.preventDefault === 'function') event.preventDefault()
              },
              onDrop: (event) => {
                if (event && typeof event.preventDefault === 'function') event.preventDefault()
                const list = event && event.dataTransfer ? event.dataTransfer.files : null
                const file = list && list.length > 0 ? list[0] : null
                if (file && typeof onDropAudio === 'function') onDropAudio(file)
              },
            },
            h(
              'div',
              { style: S.rowGap },
              h('input', {
                style: Object.assign({}, S.input, { flex: 1 }),
                value: form.ref_audio,
                onChange: (event) => setForm(Object.assign({}, form, { ref_audio: event.target.value })),
              }),
              h(Btn, { onClick: () => onBrowse(form.ref_audio, 'ref'), disabled: busy === 'browse' }, t('browse')),
              h(Btn, { onClick: () => onAsr(form.ref_audio), disabled: busy === 'asr' }, t('asr')),
            ),
            h('div', { style: S.meta }, t('refDrop')),
          ),
        ),
        asrState ? h('div', { style: { color: C.dim, fontSize: '10.5px' } }, asrState) : null,
        props.editMode ? h('div', { style: S.meta }, t('editHint')) : null,
        browse ? h(Browse, { t, browse, kind: props.browseKind, onOpen: onBrowse, onPick: props.onPick }) : null,
        h(
          Field,
          { label: t('promptText'), hint: t('promptHint') },
          h('textarea', {
            style: Object.assign({}, S.input, { resize: 'vertical', minHeight: '46px' }),
            rows: 2,
            value: form.prompt_text,
            onChange: (event) => setForm(Object.assign({}, form, { prompt_text: event.target.value })),
          }),
        ),
        h(
          'div',
          { style: S.actions },
          h(Btn, { primary: true, onClick: onSubmit, disabled: busy === 'add' }, props.submitLabel || t('submit')),
          h(Btn, { onClick: onCancel }, t('cancel')),
        ),
      )
    }

    function Browse(props) {
      const { t, browse, onOpen, onPick, onPickDir } = props
      const dirs = browse.dirs || []
      const files = browse.files || []
      return h(
        'div',
        { style: S.browseBox },
        h('div', { style: S.meta }, browse.path),
        h(
          'div',
          { style: S.actions },
          browse.parent ? h(Btn, { onClick: () => onOpen(browse.parent) }, t('up')) : null,
          onPickDir ? h(Btn, { primary: true, onClick: () => onPickDir() }, t('pickHere')) : null,
          ...(browse.roots || []).map((root) => h(Btn, { key: root, onClick: () => onOpen(root) }, root)),
        ),
        ...dirs.map((name) =>
          h(
            'div',
            {
              key: 'd:' + name,
              style: S.link,
              onClick: () => onOpen(joinPath(browse.path, name)),
            },
            '▸ ' + name,
          ),
        ),
        ...files.map((item) =>
          h(
            'div',
            {
              key: 'f:' + item.name,
              style: Object.assign({}, S.link, { color: C.sub }),
              onClick: () => onPick(item),
            },
            (props.kind === 'weights' ? '⚙ ' : '♪ ') + item.name + '  (' + item.size_mb + 'MB)',
          ),
        ),
      )
    }

    // ---------------------------------------------------------------- 一键训练
    // 录音与日志偏移放在模块级：面板每次切进来都重新计数，避免 useState 里塞可变引用
    let activeRecorder = null
    let recordChunks = []
    let trainLogOffset = 0

    function TrainPane(props) {
      const { t, onBack, onDone } = props
      const [name, setName] = useState('')
      const [s2Epochs, setS2Epochs] = useState(8)
      const [s1Epochs, setS1Epochs] = useState(15)
      const [files, setFiles] = useState([])
      const [separate, setSeparate] = useState(true)
      const [status, setStatus] = useState(null)
      const [error, setError] = useState('')
      const [notice, setNotice] = useState('')
      const [busy, setBusy] = useState('')
      const [browse, setBrowse] = useState(null)
      const [logText, setLogText] = useState('')
      const [recording, setRecording] = useState(false)
      const [dragging, setDragging] = useState(false)
      const [pending, setPending] = useState([])
      const [materialSec, setMaterialSec] = useState(0)
      const [stickLog, setStickLog] = useState(true)
      const logBox = useRef(null)

      // 日志自动跟随：只要用户没往上翻，就贴在最新一行
      useEffect(() => {
        if (!stickLog) return
        const el = logBox.current
        if (el) el.scrollTop = el.scrollHeight
      }, [logText, stickLog])

      /** 拖进来的文件浏览器不给真实路径 → 先上传到服务端 data/uploads，再把返回的路径加进素材。 */
      // 拖拽只在「本面板」范围内生效。
      // 之前把事件挂在面板根节点上，但 DSH 自己有窗口级的拖入遮罩（整屏铺一个拖入框），
      // 遮罩会盖住面板；这里改成在 window 的捕获阶段先截胡，只在指针落在面板内时
      // preventDefault + stopPropagation，宿主就收不到这次拖拽，不会弹全屏遮罩。
      const paneRef = useRef(null)
      const dragDepth = useRef(0)
      useEffect(() => {
        if (typeof window === 'undefined' || !window.addEventListener) return () => {}
        const root = () => paneRef.current
        const inside = (event) => {
          const el = root()
          if (!el || !event) return false
          const target = event.target
          if (target && typeof el.contains === 'function' && el.contains(target)) return true
          // 拖拽过程中 target 有时是遮罩/文档本身，退回按坐标判断
          if (typeof event.clientX === 'number' && typeof el.getBoundingClientRect === 'function') {
            const box = el.getBoundingClientRect()
            return (
              event.clientX >= box.left && event.clientX <= box.right &&
              event.clientY >= box.top && event.clientY <= box.bottom
            )
          }
          return false
        }
        const eat = (event) => {
          if (event && typeof event.stopPropagation === 'function') event.stopPropagation()
          if (event && typeof event.preventDefault === 'function') event.preventDefault()
        }
        const onEnter = (event) => {
          if (!inside(event)) return
          eat(event)
          dragDepth.current += 1
          setDragging(true)
        }
        const onOver = (event) => {
          if (!inside(event)) return
          eat(event)
          if (!dragging) setDragging(true)
        }
        const onLeave = (event) => {
          if (inside(event)) return
          dragDepth.current = Math.max(0, dragDepth.current - 1)
          if (dragDepth.current === 0) setDragging(false)
        }
        const onDrop = (event) => {
          if (!inside(event)) return
          eat(event)
          dragDepth.current = 0
          setDragging(false)
          const list = event.dataTransfer ? event.dataTransfer.files : null
          if (list && list.length > 0) void addDropped(list)
        }
        const onEnd = () => {
          dragDepth.current = 0
          setDragging(false)
        }
        window.addEventListener('dragenter', onEnter, true)
        window.addEventListener('dragover', onOver, true)
        window.addEventListener('dragleave', onLeave, true)
        window.addEventListener('drop', onDrop, true)
        window.addEventListener('dragend', onEnd, true)
        return () => {
          window.removeEventListener('dragenter', onEnter, true)
          window.removeEventListener('dragover', onOver, true)
          window.removeEventListener('dragleave', onLeave, true)
          window.removeEventListener('drop', onDrop, true)
          window.removeEventListener('dragend', onEnd, true)
        }
      }, [])

      async function addDropped(list) {
        const picked = []
        const raw = list && typeof list.length === 'number' ? list : []
        for (let i = 0; i < raw.length; i += 1) {
          const file = raw[i]
          if (file && file.name) picked.push(file)
        }
        if (picked.length === 0) return
        setBusy('upload')
        setError('')
        setNotice(t('trainUploading'))
        setPending(picked.map((file) => file.name))
        try {
          let added = 0
          for (const file of picked) {
            const saved = await api('/upload?name=' + encodeURIComponent(file.name), {
              method: 'POST',
              raw: true,
              body: file,
            })
            setPending((current) => current.filter((item) => item !== file.name))
            if (saved && saved.path) {
              addPath(saved.path)
              added += 1
            }
          }
          setNotice(added > 0 ? t('trainDropped') : t('trainUploading'))
        } catch (err) {
          setError(describe(err))
        } finally {
          setPending([])
          setBusy('')
        }
      }

      function dropProps() {
        return {
          onDragOver: (event) => {
            if (event && typeof event.preventDefault === 'function') event.preventDefault()
            if (event && typeof event.stopPropagation === 'function') event.stopPropagation()
            setDragging(true)
          },
          onDragLeave: () => setDragging(false),
          onDrop: (event) => {
            if (event && typeof event.preventDefault === 'function') event.preventDefault()
            // 必须在冒泡到面板根之前拦下，否则同一个文件会被上传两次
            if (event && typeof event.stopPropagation === 'function') event.stopPropagation()
            setDragging(false)
            void addDropped(event && event.dataTransfer ? event.dataTransfer.files : null)
          },
        }
      }

      async function sync() {
        try {
          const data = await api('/train/status')
          // 服务端 /train/status 直接返回状态对象；只有 /train/start 才包一层 job
          const job = data && data.job ? data.job : data && typeof data.running === 'boolean' ? data : null
          setStatus(job)
          if (job) {
            const tail = await api('/train/log?offset=' + trainLogOffset + '&limit=20000')
            if (tail && typeof tail.text === 'string' && tail.text !== '') {
              trainLogOffset = Number(tail.offset || trainLogOffset)
              setLogText((current) => (current + tail.text).slice(-12000))
            }
          }
        } catch (err) {
          // 服务没起来：保持上一次状态，不刷错误
        }
      }

      useEffect(() => {
        let alive = true
        const timer = setInterval(() => {
          if (alive) void sync()
        }, 2000)
        void sync()
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [])

      // 收尾补拉：状态一旦落定（完成/失败），再补两次日志，避免「已显示完成但日志还停在半路」
      const drained = useRef('')
      useEffect(() => {
        if (!status || status.running !== false) return () => {}
        const key = String(status.started || '') + '|' + String(status.ok)
        if (drained.current === key) return () => {}
        drained.current = key
        const first = setTimeout(() => void sync(), 1600)
        const second = setTimeout(() => void sync(), 4800)
        return () => {
          clearTimeout(first)
          clearTimeout(second)
        }
      }, [status && status.running, status && status.ok])

      useEffect(() => {
        if (files.length === 0) {
          setMaterialSec(0)
          return () => {}
        }
        let alive = true
        const timer = setTimeout(() => {
          void (async () => {
            try {
              const data = await api('/audio/duration', { body: { paths: files } })
              if (alive) setMaterialSec(Number(data && data.seconds) || 0)
            } catch {
              // 服务没起来/算不出来就不显示，不打扰
            }
          })()
        }, 500)
        return () => {
          alive = false
          clearTimeout(timer)
        }
      }, [files])

      async function doStart(force) {
        if (String(name).trim() === '') {
          setError(t('trainNeedName'))
          return
        }
        if (files.length === 0) {
          setError(t('trainNeedFiles'))
          return
        }
        setBusy('start')
        setError('')
        setNotice('')
        setLogText('')
        trainLogOffset = 0
        try {
          const result = await api('/train/start', {
            body: {
          name: String(name).trim(),
          tier: 'standard',
          files,
          separate,
          force: force === true,
          s2_epochs: Number(s2Epochs) || 8,
          s1_epochs: Number(s1Epochs) || 15,
        },
          })
          if (result && result.job) setStatus(result.job)
          await sync()
        } catch (err) {
          setError(describe(err))
        } finally {
          setBusy('')
        }
      }

      async function doCancel() {
        setBusy('cancel')
        try {
          await api('/train/cancel', { body: {} })
          setNotice(t('trainCanceling'))
          await sync()
        } catch (err) {
          setError(describe(err))
        } finally {
          setBusy('')
        }
      }

      async function openBrowse(pathValue) {
        setBusy('browse')
        setError('')
        try {
          setBrowse(await api('/browse?kind=audio&path=' + encodeURIComponent(String(pathValue || '').trim())))
        } catch (err) {
          setError(describe(err))
        } finally {
          setBusy('')
        }
      }

      function addPath(full) {
        if (!full) return
        setFiles((current) => (current.indexOf(full) >= 0 ? current : current.concat([full])))
      }

      function pickPath(item) {
        const full = (item && item.full) || joinPath(browse ? browse.path : '', item && item.name ? item.name : '')
        addPath(full)
        setBrowse(null)
      }

      function pickDir() {
        if (browse) addPath(browse.path)
        setBrowse(null)
      }

      async function startRecord() {
        const nav = typeof navigator === 'object' ? navigator : null
        if (!nav || !nav.mediaDevices || typeof nav.mediaDevices.getUserMedia !== 'function' || typeof MediaRecorder !== 'function') {
          setError(t('trainNoMic'))
          return
        }
        try {
          const stream = await nav.mediaDevices.getUserMedia({ audio: true })
          recordChunks = []
          activeRecorder = new MediaRecorder(stream)
          activeRecorder.ondataavailable = (event) => {
            if (event && event.data && event.data.size > 0) recordChunks.push(event.data)
          }
          activeRecorder.onstop = () => {
            void finishRecord(stream)
          }
          activeRecorder.start()
          setRecording(true)
          setError('')
        } catch (err) {
          setError(t('trainNoMic'))
        }
      }

      async function finishRecord(stream) {
        try {
          for (const track of stream.getTracks()) track.stop()
          const blob = new Blob(recordChunks, { type: 'audio/webm' })
          if (blob.size === 0) throw new Error(t('trainNoMic'))
          const response = await fetch('/gptsovits/upload?name=record-' + Date.now() + '.webm', {
            method: 'POST',
            headers: { 'content-type': 'application/octet-stream' },
            body: blob,
          })
          const text = await response.text()
          if (!response.ok) throw new Error(text.slice(0, 160))
          const data = text ? JSON.parse(text) : {}
          addPath(data.path || '')
          setNotice(t('trainRecorded'))
        } catch (err) {
          setError(describe(err))
        } finally {
          setRecording(false)
          activeRecorder = null
        }
      }

      function toggleRecord() {
        if (recording) {
          if (activeRecorder && activeRecorder.state !== 'inactive') activeRecorder.stop()
          return
        }
        void startRecord()
      }

      const running = status !== null && status.running === true
      const done = status !== null && status.running === false && status.ok === true
      const failed = status !== null && status.running === false && status.ok === false
      const percent = status ? Math.max(0, Math.min(100, Number(status.percent || 0))) : 0
      const stageKey = status ? String(status.stage || '') : ''
      const stepIndex = TRAIN_STEP_KEYS.indexOf(stageKey)
      const stepLabels = status && Array.isArray(status.pipeline) ? status.pipeline : []
      const elapsedSec =
        status && status.started ? Math.max(0, Math.floor(Date.now() / 1000 - Number(status.started))) : 0
      const elapsedText =
        elapsedSec >= 60
          ? Math.floor(elapsedSec / 60) + t('unitMinute') + ' ' + (elapsedSec % 60) + t('unitSecond')
          : elapsedSec + t('unitSecond')
      function stepState(index) {
        if (done) return 'done'
        if (failed) return index <= stepIndex ? 'done' : 'todo'
        if (stepIndex < 0) return 'todo'
        if (index < stepIndex) return 'done'
        return index === stepIndex ? 'now' : 'todo'
      }
      function bar(color, height) {
        return h(
          'div',
          { style: Object.assign({}, S.bar, { height: height + 'px' }) },
          h('div', { style: Object.assign({}, S.barFill, { width: Math.max(2, percent) + '%', background: color }) }),
        )
      }
      function progressCard() {
        return h(
          'div',
          { style: S.card },
          h(
            'div',
            { style: S.titleRow },
            h('span', { style: S.name }, running ? t('trainRunning') : done ? t('trainDone') : t('trainFailed')),
            h('div', { style: S.grow }),
            running ? h('span', { style: S.tag }, t('trainElapsed') + ' ' + elapsedText) : null,
            h('span', { style: S.tag }, percent + '%'),
          ),
          bar(failed ? C.danger : done ? C.ok : C.primary, 8),
          h(
            'div',
            { style: S.status },
            (running ? '' : '') + String(status.stage_label || '') + (status.message ? ' · ' + status.message : ''),
          ),
          h(
            'div',
            { style: S.steps },
            ...TRAIN_STEP_KEYS.map((key, index) => {
              const state = stepState(index)
              const label = stepLabels[index] || key
              return h(
                'span',
                {
                  key,
                  style: Object.assign({}, S.stepChip, {
                    color: state === 'now' ? C.primary : state === 'done' ? C.ok : C.dim,
                    borderColor: state === 'now' ? C.primary : C.border,
                    fontWeight: state === 'now' ? 600 : 400,
                  }),
                },
                (state === 'done' ? '✓ ' : state === 'now' ? '● ' : '') + label,
              )
            }),
          ),
          status.audio_seconds ? h('span', { style: S.tag }, t('trainAudio') + ' ' + Number(status.audio_seconds).toFixed(0) + 's') : null,
          status.error ? h('div', { style: S.err }, String(status.error)) : null,
          status.error && String(status.error).includes('有效语音只有') && !running
            ? h(
                'div',
                { style: S.actions },
                h(Btn, { primary: true, disabled: busy === 'start', onClick: () => void doStart(true) }, t('trainForce')),
              )
            : null,
          status.error && String(status.error).includes('有效语音只有') && !running
            ? h('div', { style: S.meta }, t('trainForceHint'))
            : null,
        )
      }

      const body = []
      body.push(
        h(
          'div',
          { style: S.head },
          h(Avatar, { label: '🎙' }),
          h(
            'div',
            { style: S.headText },
            h('div', { style: S.headName }, t('trainTitle')),
            h('div', { style: S.status }, t('trainHint')),
          ),
          h(Btn, { disabled: busy === 'browse', onClick: () => void sync() }, t('refresh')),
          h(Btn, { onClick: onBack }, t('back')),
        ),
      )
      if (running || done || failed) body.push(progressCard())

      body.push(
        h(
          Section,
          { title: t('trainName') },
          h('input', {
            style: S.input,
            value: name,
            placeholder: t('trainNameHint'),
            disabled: running,
            onChange: (event) => setName(event.target.value),
          }),
        ),
      )
      body.push(
        h(
          Section,
          { title: t('trainTier') },
          h(
            Slider,
            {
              label: t('epochSovits'),
              value: s2Epochs,
              min: 1,
              max: 100,
              step: 1,
              disabled: running,
              suffix: t('epochUnit'),
              onChange: (next) => {
                if (!running) setS2Epochs(next)
              },
            },
          ),
          h(
            Slider,
            {
              label: t('epochGpt'),
              value: s1Epochs,
              min: 1,
              max: 100,
              step: 1,
              disabled: running,
              suffix: t('epochUnit'),
              onChange: (next) => {
                if (!running) setS1Epochs(next)
              },
            },
          ),
          h('div', { style: S.meta }, t('trainTierHint')),
        ),
      )
      body.push(
        h(
          Section,
          { title: t('trainSource'), extra: h('span', { style: S.tag }, String(files.length)) },
          files.length === 0 && pending.length === 0
            ? null
            : h(
                'div',
                { style: S.list },
                ...pending.map((item) => 
                  h(
                    'div',
                    { key: 'pending-' + item, style: S.rowGap },
                    h('span', { style: S.meta, title: item }, item + ' · ' + t('trainUploading')),
                  ),
                ),
                ...files.map((path) =>
                  h(
                    'div',
                    { key: path, style: S.rowGap },
                    h('span', { style: S.meta, title: path }, String(path).split(/[\\/]/).slice(-2).join('\\')),
                    h('div', { style: S.grow }),
                    running ? null : h(Btn, { onClick: () => setFiles((cur) => cur.filter((item) => item !== path)) }, '×'),
                  ),
                ),
              ),
          h(
            'div',
            { style: S.actions },
            h(Btn, { disabled: running || busy === 'browse', onClick: () => void openBrowse('') }, t('trainPick')),
            h(Btn, { disabled: running, onClick: toggleRecord }, recording ? t('trainRecording') : t('trainRecord')),
          ),
          h(
            'div',
            Object.assign(
              { style: dragging ? Object.assign({}, S.drop, S.dropOn) : S.drop },
              running ? {} : dropProps(),
            ),
            dragging ? t('trainDropOn') : busy === 'upload' ? t('trainUploading') : t('trainDrop'),
          ),
          materialSec > 0
            ? h(
                'div',
                { style: materialSec < 60 ? Object.assign({}, S.meta, { color: C.warn }) : S.meta },
                t('trainMaterial') + ' ' + Math.round(materialSec) + t('trainMaterialUnit') + (materialSec < 60 ? ' · ' + t('trainMaterialLow') : ''),
              )
            : null,
        ),
      )
      body.push(
        h(
          'div',
          { style: S.toggleRow },
          h(
            'div',
            { style: S.grow },
            h('div', { style: S.headName }, t('trainSeparate')),
            h('div', { style: S.status }, t('trainSourceHint')),
          ),
          h(Switch, {
            on: separate,
            disabled: running,
            onToggle: () => setSeparate(separate !== true),
          }),
        ),
      )
      if (browse !== null) {
        body.push(
          h(
            'div',
            { style: S.card },
            h(Browse, {
              t,
              browse,
              kind: 'audio',
              onOpen: (path) => void openBrowse(path),
              onPick: pickPath,
              onPickDir: pickDir,
            }),
            h('div', { style: S.actions }, h(Btn, { onClick: () => setBrowse(null) }, t('back'))),
          ),
        )
      }
      if (error !== '') body.push(h('div', { style: S.err }, error))
      if (notice !== '') body.push(h('div', { style: S.ok }, notice))
      body.push(
        h(
          'div',
          { style: S.actions },
          h(
            Btn,
            {
              primary: true,
              disabled: running || busy === 'start' || String(name).trim() === '' || files.length === 0,
              onClick: () => void doStart(),
            },
            t('trainStart'),
          ),
          // 取消按钮常驻：没在训练时置灰，避免出现「正跑着却找不到取消」或「不知道该不该点」
          h(
            Btn,
            { danger: true, disabled: !running || busy === 'cancel', onClick: () => void doCancel() },
            t('trainCancel'),
          ),
          done && onDone ? h(Btn, { onClick: onDone }, t('refresh')) : null,
        ),
      )
      if (running) {
        // 刚点完「开始训练」时视线就在这一行，进度也要在这里出现一次
        body.push(
          h(
            'div',
            { style: S.card },
            h(
              'div',
              { style: S.titleRow },
              h('span', { style: S.status }, String(status.stage_label || t('trainRunning'))),
              h('div', { style: S.grow }),
              h('span', { style: S.tag }, percent + '%'),
            ),
            bar(C.primary, 6),
          ),
        )
      }
      if (logText !== '') {
        body.push(
          h(
            'div',
            { style: S.card },
            h(
              'div',
              { style: S.titleRow },
              h('span', { style: S.meta }, t('trainLog')),
              h('div', { style: S.grow }),
              stickLog
                ? null
                : h(
                    Btn,
                    {
                      small: true,
                      onClick: () => {
                        setStickLog(true)
                        const el = logBox.current
                        if (el) el.scrollTop = el.scrollHeight
                      },
                    },
                    t('logLatest'),
                  ),
            ),
            h(
              'pre',
              {
                ref: logBox,
                style: S.log,
                onScroll: (event) => {
                  const el = event && event.currentTarget
                  if (!el) return
                  const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 28
                  setStickLog(nearBottom)
                },
              },
              logText,
            ),
          ),
        )
      }
      body.push(
        h(
          'div',
          { style: { marginTop: 'auto', paddingTop: '10px', fontSize: '10px', color: C.dim, opacity: 0.7 } },
          'gptsovits-tts · v4',
        ),
      )
      return h('div', { style: S.root, ref: paneRef }, body)
    }

    // ---------------------------------------------------------------- 主面板
    // 面板渲染出错时给出可见的错误文本，比整块空白好排查（真实 React 才有 Component，单测里退化成透传）
    const PanelBoundary = (() => {
      const Base = React.Component
      if (typeof Base !== 'function') {
        return (props) => props.children
      }
      return class PanelBoundary extends Base {
        constructor(props) {
          super(props)
          this.state = { error: null }
        }

        static getDerivedStateFromError(error) {
          return { error }
        }

        componentDidCatch(error) {
          console.error('[gptsovits-tts] 面板渲染失败', error)
        }

        render() {
          if (this.state.error) {
            const error = this.state.error
            const stack = String((error && error.stack) || '')
              .split('\n')
              .slice(0, 5)
              .join('\n')
            const message = String((error && error.message) || error) + (stack ? '\n' + stack : '')
            return h(
              'div',
              { style: { padding: '12px', color: '#e5484d', fontSize: '12px', whiteSpace: 'pre-wrap', lineHeight: '1.6' } },
              '语音模型面板渲染出错：\n' + message,
            )
          }
          return this.props.children
        }
      }
    })()

    function VoicesPane(props) {
      // 抽一层：哪怕宿主没给 t（或语言包注册失败），面板也能用自带中文兜底，不至于整块空白
      const t =
        typeof props.t === 'function'
          ? (key) => {
              let text
              try {
                text = props.t(key)
              } catch (error) {
                text = undefined
              }
              if (typeof text === 'string' && text !== '') return text
              return zh[key] !== undefined ? zh[key] : en[key] !== undefined ? en[key] : String(key)
            }
          : (key) => (zh[key] !== undefined ? zh[key] : en[key] !== undefined ? en[key] : String(key))
      const [voices, setVoices] = useState(null)
      const [meta, setMeta] = useState({ default: '', ready: false })
      const [loading, setLoading] = useState(true)
      const [error, setError] = useState('')
      const [notice, setNotice] = useState('')
      const [busy, setBusy] = useState('')
      const [view, setView] = useState('list')
      const [tab, setTab] = useState('voices')
      const [editing, setEditing] = useState(null)
      const [weights, setWeights] = useState(null)
      const [browse, setBrowse] = useState(null)
      const [browseKind, setBrowseKind] = useState('ref')
      const [asrState, setAsrState] = useState('')
      const [form, setForm] = useState({ label: '', gpt: '', sovits: '', ref_audio: '', prompt_text: '' })
      const [svc, setSvc] = useState(null)
      const [svcBusy, setSvcBusy] = useState('')
      const [engine, setEngine] = useState(null)
      const [engineBrowse, setEngineBrowse] = useState(null)
      const [engineBusy, setEngineBusy] = useState('')

      const refresh = useCallback(async (silent) => {
        if (silent !== true) setLoading(true)
        try {
          // 引擎状态先问：服务起不来时也要能把「引擎未就绪」和下载向导显示出来
          try {
            setEngine(await api('/engine'))
          } catch {
            setEngine(null)
          }
          try {
            const data = await api('/voices')
            setVoices(Array.isArray(data.voices) ? data.voices : [])
            setMeta({ default: data.default || '', ready: data.ready === true, active: data.active || '' })
            try {
              setSvc(await api('/service'))
            } catch {
              setSvc({ ok: true, service: false, loaded: false })
            }
            setWeights(null) // 下次进「新增音色」时重新扫一遍权重，放进仓库的新权重立刻可见
            setError('')
          } catch (err) {
            setVoices([])
            setMeta({ default: '', ready: false, active: '' })
            setSvc({ ok: true, service: false, loaded: false })
            setError(describe(err))
          }
        } finally {
          setLoading(false)
        }
      }, [])

      useEffect(() => {
        void refresh()
      }, [refresh])

      // 引擎下载/解压期间每秒问一次进度，完成或失败后停
      const dlPhase = engine && engine.download ? String(engine.download.phase || 'idle') : 'idle'
      const dlActive = dlPhase === 'downloading' || dlPhase === 'verifying' || dlPhase === 'unpacking'
      useEffect(() => {
        if (!dlActive) return undefined
        const timer = setTimeout(async () => {
          try {
            const state = await api('/engine/status')
            setEngine((prev) => Object.assign({}, prev || {}, { download: state }))
            if (state && state.phase === 'done') await refresh(true)
          } catch (err) {
            setError(describe(err))
          }
        }, 1000)
        return () => clearTimeout(timer)
      }, [engine, dlActive, refresh])

      async function doSwitch(voice) {
        setBusy('switch:' + voice.id)
        setError('')
        setNotice('')
        try {
          await api('/voice', { body: { id: voice.id } })
          await refresh(true)
          setNotice(t('switchedTo') + voice.label)
        } catch (err) {
          setError(describe(err))
        } finally {
          setBusy('')
        }
      }

      async function doPreview(voice) {
        setBusy('preview:' + voice.id)
        setError('')
        setNotice('')
        try {
          await api('/preview', { body: { voice: voice.id, text: t('previewLine') } })
          setNotice(t('previewStarted') + ' · ' + voice.label)
        } catch (err) {
          setError(describe(err))
        } finally {
          setBusy('')
        }
      }

      async function doRemove(voice) {
        if (typeof window !== 'undefined' && typeof window.confirm === 'function' && !window.confirm(t('confirmRemove'))) return
        setBusy('remove:' + voice.id)
        setError('')
        setNotice('')
        try {
          await api('/voices/remove', { body: { id: voice.id } })
          await refresh(true)
          setNotice(voice.label + ' · ' + t('remove'))
        } catch (err) {
          setError(describe(err))
        } finally {
          setBusy('')
        }
      }

      async function doSvcRestart() {
        setSvcBusy('restart')
        setError('')
        setNotice('')
        try {
          const result = await api('/service/restart', { body: {} })
          setNotice(t('svcRestarted') + ' · ' + Math.round(Number(result.restart_ms) || 0) + 'ms')
          await refresh(true)
        } catch (err) {
          setError(describe(err))
        } finally {
          setSvcBusy('')
        }
      }

      async function doSvcUnload() {
        setSvcBusy('unload')
        setError('')
        setNotice('')
        try {
          await api('/service/unload', { body: {} })
          setNotice(t('svcFreed'))
          await refresh(true)
        } catch (err) {
          setError(describe(err))
        } finally {
          setSvcBusy('')
        }
      }

      async function doSvcStop() {
        if (typeof window !== 'undefined' && typeof window.confirm === 'function' && !window.confirm(t('confirmStopSvc'))) return
        setSvcBusy('stop')
        setError('')
        setNotice('')
        try {
          await api('/service/stop', { body: {} })
          setSvc({ ok: true, service: false, loaded: false })
          setNotice(t('svcStopped'))
        } catch (err) {
          setError(describe(err))
        } finally {
          setSvcBusy('')
        }
      }

      async function doSvcIdle(sec) {
        setSvcBusy('idle')
        setError('')
        setNotice('')
        try {
          const result = await api('/config', { body: { idle_unload_sec: sec } })
          setSvc((prev) => Object.assign({}, prev || {}, { idle_unload_sec: result.idle_unload_sec }))
          setNotice(t('svcIdleSaved'))
        } catch (err) {
          setError(describe(err))
        } finally {
          setSvcBusy('')
        }
      }

      async function doEngineInstall() {
        setEngineBusy('install')
        setError('')
        setNotice('')
        try {
          const state = await api('/engine/install', { body: {} })
          setEngine((prev) => Object.assign({}, prev || {}, { download: state }))
        } catch (err) {
          setError(describe(err))
        } finally {
          setEngineBusy('')
        }
      }

      async function openEngineBrowse(pathValue) {
        setEngineBusy('browse')
        setError('')
        try {
          setEngineBrowse(await api('/browse?path=' + encodeURIComponent(pathValue || '')))
        } catch (err) {
          setError(describe(err))
        } finally {
          setEngineBusy('')
        }
      }

      async function useEngineDir() {
        const dir = engineBrowse && engineBrowse.path ? engineBrowse.path : ''
        if (dir === '') return
        setEngineBusy('use')
        setError('')
        setNotice('')
        try {
          await api('/engine/use-dir', { body: { dir } })
          setEngineBrowse(null)
          setNotice(t('engineDone'))
          await refresh(true)
        } catch (err) {
          setError(describe(err))
        } finally {
          setEngineBusy('')
        }
      }

      async function doStop() {
        setError('')
        setNotice('')
        try {
          await api('/stop', { body: {} })
          setNotice(t('stopped'))
        } catch (err) {
          setError(describe(err))
        }
      }

      async function openAdd() {
        setEditing(null)
        setForm({ label: '', gpt: '', sovits: '', ref_audio: '', prompt_text: '' })
        setAsrState('')
        setView('add')
        setError('')
        setNotice('')
        if (weights !== null) return
        setBusy('weights')
        try {
          setWeights(await api('/weights'))
        } catch (err) {
          setError(describe(err))
        } finally {
          setBusy('')
        }
      }

      async function openEdit(voice) {
        setEditing(voice.id)
        setForm({
          label: voice.label || voice.id,
          gpt: voice.gpt || '',
          sovits: voice.sovits || '',
          ref_audio: voice.ref_audio || '',
          prompt_text: voice.prompt_text || '',
        })
        setAsrState('')
        setError('')
        setNotice('')
        setView('add')
        if (weights !== null) return
        setBusy('weights')
        try {
          setWeights(await api('/weights'))
        } catch (err) {
          setError(describe(err))
        } finally {
          setBusy('')
        }
      }

      async function openBrowse(pathValue, target) {
        const kind = !target || target === 'ref' ? 'audio' : 'weights'
        setBusy('browse')
        setError('')
        setBrowseKind(target || 'ref')
        try {
          setBrowse(
            await api('/browse?kind=' + kind + '&path=' + encodeURIComponent((pathValue || '').trim())),
          )
        } catch (err) {
          setError(describe(err))
        } finally {
          setBusy('')
        }
      }

      async function doAsr(target) {
        const file = (target || form.ref_audio || '').trim()
        if (file === '') {
          setError(t('needRef'))
          return
        }
        setBusy('asr')
        setAsrState(t('asrRunning'))
        setError('')
        try {
          const result = await api('/asr', { body: { path: file } })
          if (result && typeof result.text === 'string' && result.text !== '') {
            setForm((current) => Object.assign({}, current, { prompt_text: result.text }))
            setAsrState(t('asrDone') + ' · ' + result.text)
          } else {
            setAsrState(t('asrEmpty'))
          }
        } catch (err) {
          setAsrState('')
          setError(describe(err))
        } finally {
          setBusy('')
        }
      }

      async function pickFile(item) {
        const name = typeof item === 'string' ? item : item && item.name ? item.name : ''
        const full = (item && item.full) || joinPath(browse ? browse.path : '', name)
        if (browseKind === 'gpt' || browseKind === 'sovits') {
          setForm((current) => Object.assign({}, current, { [browseKind]: full }))
          setBrowse(null)
          setBrowseKind('ref')
          return
        }
        setForm((current) => Object.assign({}, current, { ref_audio: full }))
        setBrowse(null)
        await doAsr(full)
      }

      async function dropAudio(file) {
        if (!file || !file.name) return
        setBusy('upload')
        setError('')
        try {
          const saved = await api('/upload?name=' + encodeURIComponent(file.name), { method: 'POST', raw: true, body: file })
          if (saved && saved.path) {
            setForm((current) => Object.assign({}, current, { ref_audio: saved.path }))
          }
        } catch (err) {
          setError(describe(err))
        } finally {
          setBusy('')
        }
      }

      async function doAdd() {
        const payload = {
          label: form.label.trim(),
          gpt: form.gpt,
          sovits: form.sovits,
          ref_audio: form.ref_audio.trim(),
          prompt_text: form.prompt_text.trim(),
        }
        if (payload.label === '') {
          setError(t('needLabel'))
          return
        }
        if (payload.gpt === '' || payload.sovits === '') {
          setError(t('needWeights'))
          return
        }
        setBusy('add')
        setError('')
        setNotice('')
        try {
          if (editing !== null) {
            await api('/voices/update', { body: Object.assign({ id: editing }, payload) })
          } else {
            await api('/voices/add', { body: payload })
          }
          const wasEditing = editing !== null
          setForm({ label: '', gpt: '', sovits: '', ref_audio: '', prompt_text: '' })
          setAsrState('')
          setEditing(null)
          setView('list')
          await refresh(true)
          setNotice(wasEditing ? t('updated') : t('added'))
        } catch (err) {
          setError(describe(err))
        } finally {
          setBusy('')
        }
      }

      const items = Array.isArray(voices) ? voices : []
      const current = items.find((voice) => voice.id === meta.default) || null
      const svcOnline = svc !== null && svc.service !== false
      const svcLoaded = svcOnline && svc.loaded === true
      const idleSec = svc && typeof svc.idle_unload_sec === 'number' ? svc.idle_unload_sec : 600
      const svcLabel = svcOnline ? (svcLoaded ? t('svcRunning') : t('svcUnloaded')) : t('svcStopped')
      const lock = busy !== '' || svcBusy !== ''
      const body = []

      if (view === 'add') {
        body.push(
          h(
            'div',
            { style: S.head },
            h(Avatar, { label: editing === null ? '+' : '✎' }),
            h(
              'div',
              { style: S.headText },
              h('div', { style: S.headName }, editing === null ? t('addVoice') : t('editVoice')),
              h('div', { style: S.status }, t('hint')),
            ),
            h(Btn, { onClick: () => setView('list') }, t('back')),
          ),
        )
        if (error !== '') body.push(h('div', { style: S.err }, error))
        body.push(
          AddForm({
            t,
            weights,
            form,
            setForm,
            busy,
            browse,
            browseKind,
            asrState,
            editMode: editing !== null,
            submitLabel: editing === null ? t('submit') : t('save'),
            onBrowse: openBrowse,
            onPickWeight: (target) => openBrowse(form[target], target),
            onAsr: doAsr,
            onDropAudio: dropAudio,
            onPick: pickFile,
            onSubmit: doAdd,
            onCancel: () => {
              setEditing(null)
              setView('list')
            },
          }),
        )
        return h('div', { style: S.root }, body)
      }

      // 头部：当前音色 + 状态 + 快捷按钮
      body.push(
        h(
          'div',
          { style: S.head },
          h(Avatar, { label: current ? current.label : t('title') }),
          h(
            'div',
            { style: S.headText },
            h('div', { style: S.headName }, t('title')),
            h(
              'div',
              { style: svcOnline ? S.statusLive : S.status },
              (current ? current.label + (current.version ? ' · ' + current.version : '') + ' · ' : '') + svcLabel + ' · v4',
            ),
          ),
          h(Btn, { disabled: lock || !svcOnline, onClick: () => void doStop() }, t('stopReading')),
          h(Btn, { disabled: busy !== '', onClick: () => void refresh() }, t('refresh')),
        ),
      )
      if (error !== '') body.push(h('div', { style: S.err }, error))
      if (notice !== '') body.push(h('div', { style: S.ok }, notice))

      // 引擎向导：只要引擎没就绪（也没走 dev 路径）就顶在最上面，跨平台同理
      const engineMissing = engine === null || (engine.mode !== 'engine' && engine.mode !== 'dev')
      if (engineMissing) {
        const dl = engine && engine.download ? engine.download : null
        const dlPct = dl && typeof dl.percent === 'number' ? dl.percent : 0
        const dlBytes = dl && typeof dl.bytesTotal === 'number' && dl.bytesTotal > 0
          ? Math.round((dl.bytesDone || 0) / 1048576) + ' / ' + Math.round(dl.bytesTotal / 1048576) + ' MB'
          : ''
        const dlSpeed = dl && typeof dl.speed === 'number' && dl.speed > 0 ? (dl.speed / 1048576).toFixed(1) + ' ' + t('engineSpeed') : ''
        const phaseText = dlActive
          ? t('enginePreparing') + ' · ' + t(dlPhase === 'downloading' ? 'enginePhase_download' : dlPhase === 'verifying' ? 'enginePhase_verify' : 'enginePhase_unpack')
          : ''
        body.push(
          h(
            'div',
            { style: S.card },
            h(
              'div',
              { style: S.titleRow },
              h('span', { style: S.name }, t('engineTitle')),
              h(Chip, { tone: dlActive ? 'ok' : 'warn' }, dlActive ? String(dlPct) + '%' : t('engineMissing')),
            ),
            h('div', { style: S.meta }, t('engineHint')),
            dlActive
              ? h(
                  'div',
                  { style: S.meta },
                  phaseText + (dlBytes ? ' · ' + dlBytes : '') + (dlSpeed ? ' · ' + dlSpeed : ''),
                )
              : null,
            dlActive
              ? h(
                  'div',
                  { style: Object.assign({}, S.bar, { height: '6px' }) },
                  h('div', { style: Object.assign({}, S.barFill, { width: Math.max(2, dlPct) + '%' }) }),
                )
              : null,
            h(
              'div',
              { style: S.actions },
              h(
                Btn,
                { primary: true, small: true, disabled: dlActive || engineBusy !== '', onClick: () => void doEngineInstall() },
                dlActive ? t('enginePreparing') : t('engineDownload'),
              ),
              h(Btn, { small: true, disabled: dlActive || engineBusy !== '', onClick: () => void openEngineBrowse('') }, t('engineUseDir')),
            ),
            engineBrowse
              ? h(Browse, { t, browse: engineBrowse, onOpen: openEngineBrowse, onPickDir: useEngineDir })
              : null,
          ),
        )
      }

      // 合成服务：常驻在头部卡下面，不再单独占一个分段
      body.push(
        h(
          'div',
          { style: S.card },
          h(
            'div',
            { style: S.titleRow },
            h('span', { style: S.name }, t('svcTitle')),
            h(Chip, { tone: svcOnline ? (svcLoaded ? 'ok' : 'warn') : 'warn' }, svcLabel),
          ),
          h(
            'div',
            { style: S.svcRow },
            svcOnline && svc.pid ? h('span', { style: S.tag }, t('svcPid') + ' ' + svc.pid) : null,
            svcLoaded && (typeof svc.torch_reserved_mb === 'number' || typeof svc.torch_mb === 'number')
              ? h(
                  'span',
                  {
                    style: S.tag,
                    title:
                      '本服务 torch 张量 ' + Math.round(svc.torch_mb || 0) + 'MB' +
                      (typeof svc.vram_used_mb === 'number'
                        ? ' · 整卡已用 ' + (svc.vram_used_mb / 1024).toFixed(1) + 'G'
                        : ''),
                  },
                  t('svcVram') + ' ' + (((svc.torch_reserved_mb || svc.torch_mb) || 0) / 1024).toFixed(1) + 'G',
                )
              : null,
            svcOnline && typeof svc.uptime_s === 'number'
              ? h('span', { style: S.tag }, t('svcUptime') + ' ' + Math.round(svc.uptime_s / 60) + 'min')
              : null,
          ),
          h(
            'div',
            { style: S.actions },
            h(
              Btn,
              { primary: true, small: true, disabled: lock || !svcOnline, onClick: () => void doSvcRestart() },
              svcBusy === 'restart' ? t('restarting') : t('svcRestart'),
            ),
            h(Btn, { small: true, disabled: lock || !svcOnline, onClick: () => void doSvcUnload() }, t('svcUnload')),
            h(Btn, { small: true, danger: true, disabled: lock || !svcOnline, onClick: () => void doSvcStop() }, t('svcStop')),
          ),
          h(
            'div',
            { style: S.titleRow },
            h('span', { style: S.meta }, t('svcIdle')),
            h('div', { style: S.grow }),
            h(
              'select',
              {
                style: Object.assign({}, S.select, { flex: '0 0 auto', width: 'auto', minWidth: '104px' }),
                value: String(idleSec),
                disabled: svcBusy === 'idle',
                onChange: (event) => void doSvcIdle(Number(event.target.value)),
              },
              ...[0, 60, 300, 600, 900, 1800, 3600].map((sec) =>
                h(
                  'option',
                  { key: String(sec), value: String(sec) },
                  sec === 0 ? t('idleNever') : sec / 60 + ' ' + t('idleMinute'),
                ),
              ),
            ),
          ),
        ),
      )

      // 整行选择器：直接换朗读音色
      body.push(
        h(
          'div',
          { style: S.fullRow },
          h(
            'select',
            {
              style: S.select,
              value: current ? current.id : '',
              disabled: lock || items.length === 0,
              onChange: (event) => {
                const next = items.find((voice) => voice.id === event.target.value)
                if (next) void doSwitch(next)
              },
            },
            ...items.map((voice) =>
              h('option', { key: voice.id, value: voice.id }, voice.label + (voice.default ? ' · ' + t('inUse') : '')),
            ),
          ),
          h(Btn, { disabled: lock || !current, onClick: () => current && void doPreview(current) }, t('previewPick')),
        ),
      )

      // 分段：合成 / 训练（服务信息常驻在头部卡下面）
      body.push(
        h(Seg, {
          value: tab,
          onChange: (next) => setTab(next),
          items: [
            { value: 'voices', label: t('tabSynth') },
            { value: 'train', label: t('tabTrain') },
          ],
        }),
      )

      if (tab === 'voices') {
        body.push(
          h(
            'div',
            { style: S.sectionBar },
            h('span', { style: S.sectionTitle }, t('voiceSection')),
            items.length > 0 ? h('span', { style: S.tag }, String(items.length)) : null,
            h('div', { style: S.grow }),
            h('div', { style: S.iconBtn, onClick: () => void refresh(), title: t('refresh') }, '↻'),
          ),
        )
        if (loading && items.length === 0) body.push(h('div', { style: S.meta }, t('loading')))
        if (!loading && items.length === 0 && error === '') body.push(h('div', { style: S.meta }, t('empty')))
        if (items.length > 0) {
          body.push(
            h(
              'div',
              { style: S.grid },
              ...items.map((voice) =>
                h(VoiceCard, {
                  key: voice.id,
                  voice,
                  t,
                  busy,
                  onSwitch: (item) => void doSwitch(item),
                  onPreview: (item) => void doPreview(item),
                  onEdit: (item) => void openEdit(item),
                  onRemove: (item) => void doRemove(item),
                }),
              ),
            ),
          )
        }
        body.push(
          h(
            'div',
            { style: S.actions },
            h(Btn, { onClick: openAdd, disabled: busy === 'weights' }, t('addVoice')),
            h(Btn, { onClick: () => setTab('train') }, t('train')),
          ),
        )
      }

      // 训练页常驻挂载、只切显隐：切到「合成」再切回来时，素材/名称/轮数/日志都还在，
      // 正在上传的拖入文件也不会因为组件卸载而丢掉。
      body.push(
        h(
          'div',
          { style: tab === 'train' ? null : S.hidden },
          h(TrainPane, {
            t,
            onBack: () => {
              setTab('voices')
              void refresh(true)
            },
            onDone: () => {
              setTab('voices')
              void refresh(true)
              setNotice(t('trainDone'))
            },
          }),
        ),
      )

      return h('div', { style: S.root }, body)
    }

    // ---------------------------------------------------------------- 注册
    return {
      inject: ['slots', 'locale', 'sidebarRightTabs'],
      // 便于单测：正文转成「能念的文本」（脱掉行内代码反引号、保留内容）
      plainForSpeech,
      apply(ctx) {
        // 注册失败（例如某个服务版本没有 sidebarRightTabs）只记日志，不能连带别的面板一起挂掉
        try {
          // 刷新页面时同一会话里 namespace 可能已注册过（会抛 already-taken），必须各自兜住：
          // 这里一旦抛异常，下面的 tab 类型与正文槽位都不会注册 → 侧边栏只剩空壳。
          for (const [locale, dict] of [['en', en], ['zh', zh]]) {
            try {
              ctx.effect(() => ctx.locale.register(NS, locale, dict), 'gptsovits-tts: locale ' + locale)
            } catch (error) {
              console.error('[gptsovits-tts] 语言包注册失败（刷新后常见，忽略）', error)
            }
          }
          const t = ctx.locale.bind(NS)

          const Panel = (slotProps) =>
            h(PanelBoundary, null, h(VoicesPane, Object.assign({}, slotProps, { t })))

          ctx.effect(
            () =>
              ctx.sidebarRightTabs.register({
                id: KIND,
                kind: KIND,
                priority: 'builtin',
                title: () => t('title'),
                keepMounted: true,
                guide: [
                  {
                    id: 'voices',
                    kind: KIND,
                    order: 60,
                    title: () => t('title'),
                    description: () => t('hint'),
                  },
                ],
              }),
            'gptsovits-tts: sidebar tab type',
          )

          ctx.effect(
            () =>
              ctx.slots.inject('sidebar.right.pane.tab', () =>
                ctx.slots.register({ name: 'sidebar.right.pane.tab', key: KIND, locale: NS }, Panel),
              ),
            'gptsovits-tts: sidebar pane body',
          )

          // 助手消息底部操作栏里的「朗读 / 暂停」按钮：单独 try，挂掉不能连带侧边栏面板
          const ReadAction = (slotProps) => h(ReadButton, Object.assign({}, slotProps, { t }))
          try {
            ctx.effect(
              () =>
                ctx.slots.inject('conversation.chat.assistant-actions', () =>
                  ctx.slots.register(
                    { name: 'conversation.chat.assistant-actions', id: 'gptsovits-tts', order: 20, locale: NS },
                    ReadAction,
                  ),
                ),
              'gptsovits-tts: message read button',
            )
          } catch (error) {
            console.error('[gptsovits-tts] 消息操作栏按钮注册失败（侧边栏与自动朗读不受影响）', error)
          }
        } catch (error) {
          console.error('[gptsovits-tts] 侧边栏面板注册失败（Host 侧朗读不受影响）', error)
        }
      },
    }
  },
})
