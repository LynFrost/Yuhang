# Yuhang

本仓库用于存放个人工具与实验项目。目前包含一个浏览器扩展项目：

## 项目

### [ChatGPT Prompt Navigator](chatgpt-prompt-navigator/)

为长 ChatGPT 对话提供“我的提问”目录和快速跳转能力的本地 Chrome / Edge 扩展。

- **当前版本：** 1.4.0
- **技术栈：** Chrome Extension Manifest V3、JavaScript、CSS
- **支持页面：** `chatgpt.com`、`chat.openai.com`
- **核心能力：**
  - 自动提取当前会话中的用户提问，生成侧边目录。
  - 点击目录项即可定位到对应提问。
  - 支持关键词筛选、目录收起/展开。
  - 支持快捷键在提问之间移动。
  - 针对 ChatGPT 长对话的虚拟列表进行渐进式导航，避免依赖尚未渲染的 DOM 节点。
  - 优先通过消息 ID 精确定位；必要时使用兼容性回退方式。

**快捷键**

| 快捷键 | 操作 |
| --- | --- |
| `Alt + ↑` | 上一条我的提问 |
| `Alt + ↓` | 下一条我的提问 |
| `Alt + Home` | 第一条我的提问 |
| `Alt + End` | 最后一条我的提问 |

**安装**

1. 下载或克隆本仓库。
2. 打开 Chrome 的 `chrome://extensions/` 或 Edge 的 `edge://extensions/`。
3. 开启“开发者模式”。
4. 点击“加载解压缩的扩展”，选择仓库中的 `chatgpt-prompt-navigator` 文件夹。
5. 打开或刷新 ChatGPT 页面。

详细功能、隐私说明、兼容性说明和更新记录请阅读项目自己的 [README](chatgpt-prompt-navigator/README.md)。

## 隐私说明

ChatGPT Prompt Navigator 不包含遥测、第三方请求或远程脚本。为处理长对话的 DOM 虚拟化，扩展会在 ChatGPT 当前站点内只读访问会话相关接口；具体数据范围与回退行为请以 [项目说明](chatgpt-prompt-navigator/README.md) 为准。

## 仓库结构

```text
Yuhang/
├── README.md
└── chatgpt-prompt-navigator/
    ├── README.md
    ├── manifest.json
    ├── content.js
    └── styles.css
```
