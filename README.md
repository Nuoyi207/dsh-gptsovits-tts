# dsh-gptsovits-tts

**让你的 DSH 用自己的声音说话。** 这个插件本身不含任何模型代码，语音合成的能力全部来自开源项目 [GPT-SoVITS](https://github.com/RVC-Boss/GPT-SoVITS)（作者 **花儿不哭 / RVC-Boss**），用的是它的 V2ProPlus 版本。推理全部在本机 GPU 完成，不联网、不上传任何音频。

- 🔊 **朗读**：DSH 回复自动朗读，每条消息底部有「▶ 朗读 / ⏸ 暂停」按钮
- 🎭 **换音色**：右侧边栏「语音模型」面板，卡片点一下即切换（约 1 秒），可试听、编辑、移除
- 🎓 **训新音色**：把录音/视频拖进面板，自动分离人声 → 切片 → 识别 → 训练 → 注册，全程不碰命令行
- ⚡ **快**：9 字回复首包约 0.35 秒（p50），句间无空档（合成与播放并行）
- 💾 **省显存**：常驻约 1.2–1.3 GB，空闲 10 分钟自动卸载，下次说话自动加载

---

## 致谢

这个插件能说话，99% 的功劳不是我的：

- **[GPT-SoVITS](https://github.com/RVC-Boss/GPT-SoVITS)** —— 作者 **花儿不哭**（GitHub: [RVC-Boss](https://github.com/RVC-Boss)）。语音合成、音色克隆、一键训练的全部能力都来自这个开源项目，连运行时用的也是它官方整合包里的环境。本项目做的是把它包成 DSH 插件：朗读、侧边栏面板、引擎自动安装这些外围工作。
- 以及 GPT-SoVITS 站在其肩膀上的那些工作：SoVITS / VITS、HuBERT、chinese-roberta-wwm-ext-large、BigVGAN、eres2net 说话人向量、FunASR 语音识别、UVR5 人声分离等。

觉得这个插件的音色好听、训练顺手的话，请去给 [GPT-SoVITS](https://github.com/RVC-Boss/GPT-SoVITS) 点个 Star —— 那才是这份能力的来源。

---
## 安装

```powershell
# 从 GitHub 安装（无需 npm）
dsh plugin --profile web add github:Nuoyi207/dsh-gptsovits-tts
# 已发布到 npm 时也可以按包名装
dsh plugin --profile web add <包名>
```

装好重启 DSH，右侧边栏会出现「语音模型」标签页。

## 首次使用

第一次打开面板会看到「语音引擎 未就绪」：

1. 点 **下载并安装**（约 11.4 GB，切 7 片，支持断点续传与 sha256 校验）；
2. 完成后自动解压、启动本地合成服务，面板出现音色卡片；
3. 已经装过 GPT-SoVITS 的，可点 **用已有目录…** 直接指定（目录里要有 `runtime/` 与 `GPT_SoVITS/`）。

引擎默认放在 `%LOCALAPPDATA%\dsh-gptsovits-tts\engine`，与 DSH 升级无关；想换位置改配置项 `engineDir`。

## 用法

| 场景 | 操作 |
| --- | --- |
| 自动朗读 | 默认开启；每条消息底部也有「▶ 朗读」按钮 |
| 换朗读音色 | 面板卡片上的 **设为朗读** |
| 试听 | 卡片上的 **试听**（播完自动切回默认音色） |
| 语速 | 配置项 `speed`（1.0 为原速） |
| 导入已有权重 | **新增音色** → 选 GPT / SoVITS 权重 → 选或拖 3–10 秒参考音频 → 自动识别台词 → 保存 |
| 训练新音色 | 切到 **训练** 分段 → 填名字 → 拖入素材 → 选轮数（默认 SoVITS 8 / GPT 15）→ 开始 |

训练至少需要约 1 分钟有效人声（切片 + 识别之后）；训练期间合成暂停，结束后自动恢复并把新音色加入列表。

> 安装器的磁盘策略：**边下载边解压**（下完一片 → 校验 → 解压 → 删片），
> 峰值占用约「最大分片 + 解压后总量」≈ 12 GB，而不是「全部分片 + 解压后」≈ 23 GB。
> 开始前会用 `statfs` 检查可用空间，不够就直接报中文错误（需要多少 / 可用多少）。

## 常见问题

**为什么第一次要下 11 GB？**
引擎包含 Python、PyTorch(CUDA)、GPT-SoVITS 底模与声码器，塞不进 npm 包。只下一次，之后所有音色共用。

**显存不够 / 没有 NVIDIA 显卡？**
需要 CUDA 11.8 兼容驱动。8 GB 显存（如 RTX 2080）可跑 V2ProPlus；更小的卡建议开「空闲释放显存」。

**下载很慢或中断？**
分片下载，中断后重新点「下载并安装」会从断点继续；也可以手动解压到任意目录后用「用已有目录…」。

**杀毒软件报警？**
包内含 python 与 torch 二进制，流程是「下载后解压执行」，容易被误判。每片下载完都校验 sha256，不过会自动删除重下。

**声音版权？**
内置诺艾尔 / 爱莉希雅音色仅用于功能演示，版权归原权利人；正式使用请导入或训练你有权使用的音色。

## 配置项

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关 |
| `voice` | `auto` | `auto` 跟随面板里的默认音色，也可写死音色 id |
| `speed` | `1` | 语速倍数 |
| `autoSpeak` | `true` | 回复自动朗读 |
| `debounceMs` | `350` | 回复停顿多久后开始朗读 |
| `engineDir` | 空（默认） | 引擎目录 |
| `autoDownload` | `true` | 引擎缺失时自动下载 |
| `downloadBase` | 空（内置地址） | 引擎分片下载根，可自建镜像 |

音色配置（`voices.json`）、导入的参考音频、训练产物都在 `%LOCALAPPDATA%\dsh-gptsovits-tts\data`，
与引擎目录分开：重装或升级引擎不会丢音色。

## 架构

```
DSH Host 插件 (lib/index.js)
  ├─ 监听 session/event → 抽正文 → 防抖 → POST /speak
  ├─ /gptsovits/* 反代到本地服务
  └─ lib/engine.js：下载 / 校验 / 解压 / 定位引擎

本地合成服务 (lib/server/server.py，FastAPI :9866)
  ├─ 载入 GPT-SoVITS 权重，缓存每个音色的参考特征
  ├─ 合成：分句 → GPT(语义) → SoVITS(声码) → wav
  └─ 播放：winsound 队列，支持暂停 / 继续 / 空闲卸载

客户端 (lib/client.js)
  ├─ 右侧边栏「语音模型」：音色卡片 / 训练页 / 引擎向导
  └─ 消息操作栏：朗读、暂停、继续
```

## 开发

```powershell
node test/plugin_unit.mjs
node test/plugin_client.test.mjs
node test/plugin_routes.test.mjs
```

用本机已有引擎调试：写一份 `%LOCALAPPDATA%\dsh-gptsovits-tts\paths.json` 指向你的整合包（字段 `pythonPath / repoPath / serverScript / logPath`）。

引擎打包与发布流程见 [docs/发布指南.md](docs/发布指南.md)。

## License

代码 MIT。GPT-SoVITS 及其预训练权重遵循上游协议；内置音色仅供演示。

## 开发

```powershell
node test/run_all.mjs   # 7 个套件
```
