# MiniMax Code MiniApps

English | [简体中文](README.zh-CN.md)

The official community repository for MiniApps built for the MiniMax Code desktop app.

Each MiniApp is a complete Plugin package stored under `plugins/<github-username>/<plugin-id>/`. Download an app to try it out, or contribute one of your own.

## MiniApps

| MiniApp | Description | Author |
| --- | --- | --- |
| [Token Usage Board](plugins/amszuidas/mcode-token-usage-board/) | View daily local Token usage, filtered by date, model, and session | [amszuidas](https://github.com/amszuidas) |

## Download and install

1. Click **Code → Download ZIP** and extract the repository, or clone it locally.
2. Find the MiniApp you want under `plugins/<github-username>/`.
3. Copy the **entire plugin directory** into `<dataDir>/plugins/` in your active MiniMax Code data directory. Include the hidden `.minimax-plugin` directory.
4. Restart a version of MiniMax Code that supports MiniApps, confirm that the plugin is loaded and enabled, and open the MiniApp. See its README for usage instructions.

For example, Token Usage Board uses these paths:

```text
In this repository: plugins/amszuidas/mcode-token-usage-board/
After installation: <dataDir>/plugins/mcode-token-usage-board/
```

`<dataDir>` is the data directory used by your running MiniMax Code instance. The author directory, `amszuidas/`, only groups contributions in this repository; do not copy that extra level into the client. After installation, the manifest should be at `<dataDir>/plugins/mcode-token-usage-board/.minimax-plugin/plugin.json`.

Install these MiniApps manually; do not use the client's GitHub plugin import feature. To update a plugin, close the MiniApp before replacing its entire plugin directory.

## Contribute

Add a complete plugin package under your GitHub username, include usage instructions, and open a pull request. See the [contribution guide (中文)](CONTRIBUTING.md) for details.

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

## License

This repository uses the [MIT License](LICENSE). Each MiniApp is subject to the license in its own directory. Before installing an app, read its documentation to understand which local files or network services it accesses.
