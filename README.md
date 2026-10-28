# PvZ2 Gardendless 网页适配与云存档

本项目 fork 自 [Gzh0821/pvzge_web](https://github.com/Gzh0821/pvzge_web)，在保留上游源码与历史的基础上，提供适用于 Windows、Linux 和 Android 浏览器的 GP-Next 网页适配与云存档服务。

当前浏览器适配对应 **Gardendless 0.16.0 / GP-Next 1.5.5**。上游原版内容保留在原目录，本项目的运行资源使用独立的 `docs-0160/`。

## 功能

- 将 GP-Next 使用的桌面文件接口映射到浏览器 IndexedDB，保留本地模组和配置。
- 支持 Android 单指点击、种植、全屏与横竖屏等比例显示。
- 手机端的云存档和全屏控件位于右下角，避开右上角暂停键。
- 使用同一个 6 位数字码，在不同设备同步玩家进度和游戏设置。
- 云存档通过浮层打开，读取后直接更新运行中的玩家、设置和余额，无需刷新页面或重启游戏。

## 存档与同步

首次输入数字码后自动连接。已有云档会先下载，空存档空间会接收本地进度；替换前保留一份本地备份。

平时只保存本地，不持续上传，也不定时轮询。以下操作会自动保存并触发同步：

- 关卡完成、奖励结算和退出战斗。
- 退出花园。
- 商店、装扮或花园格子购买成功，保存所得内容和扣款后的余额。
- 切出游戏页面或离开页面。

进入或切回游戏、恢复联网时，会自动检查云端更新。同步失败时保留本地进度，在下一个保存节点或恢复联网后重试；页面中的“立即同步”可用于手动重试。

仅同步 `PvZ2_PlayerProperties` 和 `PvZ2_Settings`，不上传模组、GP-Next 配置及其他浏览器数据。冲突按设备写入时间选择较新的整份存档，不逐字段合并。请保持设备时间准确。

云档保存的是已持久化的进度和设置，不包含另一设备的完整战斗现场。读取时保留当前场景，不会自动跳转到另一设备所在的页面。

**数字码就是访问凭据，知道数字码的人可以读取或覆盖存档，请勿公开自己的数字码。** 浏览器关闭页面时可能中止尚未完成的网络请求，本地已保存的进度会在下次连接时继续处理。

## 部署

需要 Docker Compose，以及从官方发行包提取的 **0.16.0 Standard 版 Tauri 静态资源**。

建议稀疏克隆，避免下载上游的大资源：

```sh
git clone --filter=blob:none --sparse --single-branch --branch main https://github.com/HosisoraLing/pvzge-gpnext.git
cd pvzge-gpnext
git sparse-checkout set docs-0160 LICENSES
```

从[官方发行页](https://github.com/Gzh0821/pvzg_site/releases)获取对应版本，将提取出的静态资源放入 `docs-0160/`。放好资源后，以本仓库的 `docs-0160/index.html`、`tauri-shim.js` 和 `cloud.html` 为准：这些文件是浏览器入口，不要被桌面版同名文件覆盖。

```sh
docker compose up -d
docker compose ps
```

启动后访问 `http://服务器地址:8096/`。

| 服务 | 作用 |
| --- | --- |
| `gpnext-web` | nginx 提供游戏页面，并转发同源 `/api/` 请求 |
| `cloud-save` | Node.js 云存档接口，不单独暴露宿主机端口 |
| `cloud-saves` | Docker 持久卷，保存云端存档 |

浏览器的本地进度位于 localStorage，模组和配置位于 IndexedDB。云端存档位于 `cloud-saves` 持久卷。**更新服务时保留该卷，不要执行 `docker compose down -v`。**

## 文件说明

| 路径 | 用途 |
| --- | --- |
| `tauri-shim.js` | 浏览器接口、触摸适配、存档节点及云同步逻辑 |
| `cloud.html` | 云存档页面 |
| `cloud-server.mjs` | 同源云存档服务 |
| `docker-compose.yml`、`nginx.conf` | 部署配置 |
| `docs-0160/` | 本项目浏览器版入口与本地运行资源 |
| `LICENSE`、`LICENSES/Apache-2.0.txt`、`NOTICE` | 许可证及来源说明 |

完整的 0.16.0 提取资源、真实存档、浏览器资料、截图、验证记录和本项目测试脚本不纳入版本控制。上游原有文件及其历史保留在 fork 中。

## 云存档接口

- `GET /api/cloud/123456`：读取；`200` 为存档，`404` 为空。
- `PUT /api/cloud/123456`：上传 JSON；成功返回 `200`，旧版本或同时间不同内容返回 `409` 和服务器现有存档。
- 请求上限 5 MiB，包含格式检查、原子写入及按 IP 限流。

```json
{"version":1,"updatedAt":1792953600000,"data":{"PvZ2_PlayerProperties":"[{\"name\":\"示例玩家\"}]","PvZ2_Settings":"{\"PlayerIndex\":0}"}}
```

## 许可证与来源

本项目新增的浏览器适配、云存档服务和相关修改采用 **GNU Affero General Public License v3.0（AGPL-3.0-only）**，全文见 [LICENSE](LICENSE)。网络服务使用者可从[本仓库](https://github.com/HosisoraLing/pvzge-gpnext)获取对应源码。

上游 [Gzh0821/pvzge_web](https://github.com/Gzh0821/pvzge_web) 原有代码保留 **Apache-2.0** 许可，原许可证全文保存于 [LICENSES/Apache-2.0.txt](LICENSES/Apache-2.0.txt)，来源与修改说明见 [NOTICE](NOTICE)。

本项目许可证不重新授权第三方引擎、字体、美术、音频及其他资源；它们保留各自的权利和许可声明。
