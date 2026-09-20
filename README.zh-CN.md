# MiniMax Code MiniApps

[English](README.md) | 简体中文

MiniMax Code 桌面端 MiniApp 官方社区仓库，分享由开发者共同创造的作品。

每个 MiniApp 都是一个完整的 Plugin 包，按作者放在 `plugins/<github-username>/<plugin-id>/` 下。欢迎下载体验，也欢迎贡献自己的作品。

## MiniApps

| MiniApp | 介绍 | 作者 |
| --- | --- | --- |
| [Token 用量看板](plugins/amszuidas/mcode-token-usage-board/README.zh-CN.md) | 查看本机每日 Token 用量，按时间、模型和会话筛选 | [amszuidas](https://github.com/amszuidas) |

## 下载与使用

1. 点击 **Code → Download ZIP** 下载并解压仓库，或 clone 到本地。
2. 在 `plugins/<github-username>/` 下找到想用的 MiniApp。
3. 将最内层的**完整插件目录**复制到 MiniMax Code 当前数据目录的 `<dataDir>/plugins/` 下，保留 `.minimax-plugin` 隐藏目录。
4. 重新启动支持 MiniApp 的 MiniMax Code，确认插件已加载并启用，再打开对应 MiniApp。具体用法见作品 README。

例如 Token 用量看板的路径：

```text
仓库中：plugins/amszuidas/mcode-token-usage-board/
安装后：<dataDir>/plugins/mcode-token-usage-board/
```

`<dataDir>` 是客户端当前使用的数据目录；作者目录 `amszuidas/` 只用于仓库归类，不需要复制到客户端。安装后应能找到 `<dataDir>/plugins/mcode-token-usage-board/.minimax-plugin/plugin.json`。

本仓库采用手动安装方式，不使用客户端的 GitHub 插件导入入口。更新插件时，先关闭 MiniApp，再替换对应的完整插件目录。

## 贡献作品

在自己的 GitHub 用户名目录下新增一个完整插件包，并附上使用说明，然后提交 Pull Request。详见 [贡献指南](CONTRIBUTING.md)。

```text
plugins/
└── <github-username>/
    └── <plugin-id>/
        ├── .minimax-plugin/plugin.json
        ├── package.json
        ├── miniapp/
        ├── README.md
        └── LICENSE
```

## 许可证

仓库采用 [MIT License](LICENSE)，各 MiniApp 以自己目录中的许可证为准。安装前请阅读作品说明，了解它会访问哪些本地文件或网络服务。
