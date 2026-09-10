# 轻库 · MySQL 客户端 (mysql-studio-tauri)

[![Release](https://img.shields.io/github/v/release/QFNG521/mysql-studio-tauri?style=flat-square)](https://github.com/QFNG521/mysql-studio-tauri/releases/latest)
[![Build](https://github.com/QFNG521/mysql-studio-tauri/actions/workflows/release.yml/badge.svg)](https://github.com/QFNG521/mysql-studio-tauri/actions/workflows/release.yml)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey?style=flat-square)](https://github.com/QFNG521/mysql-studio-tauri/releases)

基于 **Tauri 2 + Rust(mysql crate) + 原生 JS** 的轻量 MySQL 客户端，类似 Navicat 的核心功能子集，支持 **macOS / Windows / Linux** 三平台。

## 下载

到 [Releases](https://github.com/QFNG521/mysql-studio-tauri/releases/latest) 页面下载对应平台的安装包：

| 平台 | 格式 | 说明 |
|---|---|---|
| macOS | `.dmg` / `.app.zip` | Apple Silicon（M 系列），macOS 12+ |
| Windows | `.exe`（NSIS） | x64，Windows 10+ |
| Linux | `.deb` / `.rpm` / `.AppImage` | x64，需系统带 WebKit2GTK 4.1（Ubuntu 23.04+ / Fedora 38+ 等较新发行版） |

Release 里的文件名统一以 **`qingku_`** 开头：

- `qingku_<版本>_aarch64.dmg` / `qingku_<版本>_aarch64_app.zip` — macOS
- `qingku_<版本>_x64-setup.exe` — Windows
- `qingku_<版本>_amd64.deb` / `qingku-<版本>-1.x86_64.rpm` / `qingku_<版本>_amd64.AppImage` — Linux
- `SHA256SUMS.txt` — 全部文件的校验和

> 为什么附件名不是「轻库」：GitHub 会**剥掉 Release 附件名里的非 ASCII 字符**（`轻库_0.1.1_aarch64.dmg` 会变成 `_0.1.1_aarch64.dmg`），因此下载文件名用 ASCII 的 `qingku`。安装后的显示名、开始菜单、窗口标题仍然是「轻库」，不受影响。

> Windows 只提供 NSIS 安装包，不出 MSI：WiX 的 `light.exe` 不支持非 ASCII 输出文件名，而产品名是「轻库」，会生成 `轻库_x.y.z_x64_en-US.msi` 导致打包失败。NSIS 完整支持 Unicode，安装界面、开始菜单、安装目录都能正常显示中文。
>
> 安装包目前**未做代码签名与公证**：macOS 首次打开需右键 → 打开；Windows 可能被 SmartScreen 提示，选择「仍要运行」；Linux AppImage 需先 `chmod +x`。

## 功能

- **连接管理**：多连接保存（本机 JSON 持久化）、测试连接、断开、编辑；支持 **SSH 隧道**（密码或私钥认证，经跳板机访问内网库；连接时自动建隧道、断开时关闭，测试连接也会先验证 SSH 可达）
- **对象浏览**：连接 → 数据库 →「表 / 查询」两级树；树交互为 Finder 风格——单击选中、双击展开/折叠、点箭头立即切换；数据库节点右键菜单（打开表列表 / 打开查询列表 / 新建表 / 新建查询 / 刷新 / 展开 / 复制库名），全局搜索筛选
- **表列表页**：点击库下的「表」打开，展示该库全部表/视图（类型、行数、引擎、注释、大小），支持搜索筛选、双击打开数据、右键打开结构页
- **保存的查询**：点击库下的「查询」打开列表页，可新建 / 重命名 / 删除 / 双击打开；查询页 ⌘S 或「保存」按钮命名保存（再次 ⌘S 覆盖更新、「另存为」存副本）；SQL 预览带语法高亮，保存后切回列表自动刷新。重复打开同一条保存查询只激活已有标签页，不会重复开新页
- **查询页 · SQL 文件**：工具栏「文件 ▾」支持打开 `.sql` 文件（⌘O）/ 保存为 SQL 文件（⌘⇧S）/ 另存为 / 在文件管理器中显示（macOS 呼出 Finder 并选中）。读取时自动识别 UTF-8 / UTF-16 / **GBK**（Navicat、记事本在 Windows 导出的 `.sql` 常见），写入统一带 UTF-8 BOM 便于其他编辑器识别；同一文件重复打开按路径复用标签页
- **查询页 · 编辑器交互**：选中文本后「执行选中」只跑选区（⌘⏎ / ⇧⏎ 同效），编辑器右键菜单提供运行已选择 / 运行当前语句 / 运行全部、选择当前语句、美化 SQL、简化 SQL、剪切复制粘贴与全选；标签页右键可批量关闭（关闭其他 / 关闭左侧 / 关闭右侧 / 全部关闭），关闭前会检查未保存的查询并弹「保存 / 不保存 / 取消」
- **数据浏览与编辑**：分页浏览、列排序、WHERE 筛选；双击单元格直接 UPDATE（主键定位、NULL 支持、编辑确认可关）；新增行、勾选删除；无主键表自动只读
- **导出**：查询页与数据页均可导出 **CSV / JSON / Excel**（点「导出」先选格式；JSON 保留数据类型，Excel 表头加粗冻结、数值列可直接求和）；数据页另可导出 **SQL INSERT 脚本**（默认导全表，带筛选条件时只导筛选结果；每 100 行一条多值 INSERT；中文/NULL/引号/二进制均正确转义，冒烟测试含「导出→回灌→数据一致」验证）
- **外键跳转**：数据页单元格右键，可跳到父表对应记录 / 子表关联记录（自动拼多列外键的 AND 条件），也可「仅显示该值」；跳转复用已有标签页，不会每次都开新页
- **可视化筛选器**：工具栏「🔍 筛选器」，多条件 AND/OR 组合，支持 `= ≠ > < ≥ ≤、LIKE、IN、BETWEEN、IS (NOT) NULL`，实时预览生成的 SQL，改动可自动应用；也保留手写 WHERE 输入框
- **表结构**：列 / 索引 / **外键** / DDL 四个子页；外键页同时展示「本表指向其他表」和「其他表指向本表」（反向引用），带约束名、列、ON UPDATE/DELETE 规则，点击父/子表可直接跳到其数据页
- **可视化表设计器**：表列表右键「设计表」、结构页「✏ 设计」、库右键/表列表「＋ 新建表」进入。图形化编辑列（名/类型/可空/主键/自增/默认值/注释，支持上下移排序）、索引（唯一/方法）、外键（引用与 ON DELETE/UPDATE 规则）；底部实时生成 SQL 预览，改表按 diff 生成最小 ALTER（ADD/MODIFY/CHANGE/DROP COLUMN、主键迁移、索引与外键增删改），执行前确认框列出删列/删主键等危险操作；主键列自动强制 NOT NULL。建表/改表逻辑为纯函数并有 15 项单测 + 真库执行验证
- **SQL 高亮**：查询编辑器、结果区 SQL、DDL 子页、保存查询列表共用同一套 CodeMirror SQL 高亮（配色对齐 Navicat 默认方案：关键字/数据类型蓝色加粗、字符串与数字红色、注释绿色斜体、函数紫色；反引号对象名保持黑色；DDL 为只读查看器）
- **查询结果右键**：复制值 / 复制整行（TSV）/ 复制列名 / 复制整行为 JSON

## 开发

```bash
npm install          # 前端依赖
npm run build        # esbuild 打包前端到 dist/
cd src-tauri && cargo build
cd .. && npx tauri dev      # 运行（直接使用 dist 静态资源）
npx tauri build             # 按当前平台打包（见下表）
```

各平台的打包格式由 `src-tauri/` 下的平台专属配置决定（与主配置按 JSON Merge Patch 合并）：

| 平台 | 配置文件 | 产物 |
|---|---|---|
| macOS | `tauri.macos.conf.json` | `.app`、`.dmg` |
| Windows | `tauri.windows.conf.json` | `.exe`（NSIS） |
| Linux | `tauri.linux.conf.json` | `.deb`、`.rpm`、`.AppImage` |

> Linux 构建需先装系统依赖：
> `sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev`

> 前端构建用 esbuild（`build.mjs`）而非 vite——本机内存受限环境下 vite 会被 OOM 杀掉。
> crates.io 走 rsproxy 镜像（`src-tauri/.cargo/config.toml`，仅项目级生效）；CI 环境不使用该镜像。

前端逻辑（筛选条件拼装、SQL 高亮输出、建表/改表 DDL 生成）是纯函数，有独立单测：

```bash
npm test        # filter / sql-highlight / sql-format / dom-refs / design 五套测试
```

UI 交互可用无头浏览器验证：`tests/harness/index.html` 是 stub 掉 Tauri invoke 的验证页（mock 数据），启动 `python3 tests/harness/serve.py 8899` 后打开 `http://127.0.0.1:8899/tests/harness/index.html`。注意必须用 `serve.py`（发送 no-store 头），并配合页面里的时间戳加载器，否则浏览器会缓存旧的 `dist/assets/app.js`，误以为改动没生效。

## 发布

打标签推送即可自动出三平台安装包：

```bash
git tag -a v0.1.1 -m "版本说明"
git push origin v0.1.1
```

`.github/workflows/release.yml` 会在 macOS / Windows / Linux 三个 runner 上并行构建（跑前端单测 + Rust release 编译 + 打包），产物汇总到一个 Release job 里创建 Release、上传安装包并生成 `SHA256SUMS.txt`。也可以在 Actions 页面手动触发并指定标签。

汇总 job 会先把各 artifact 里的文件摊平到 `dist/`（`upload-artifact` 会保留 `bundle/` 下的 `dmg/`、`macos/`、`deb/` 等子目录，直接 `sha256sum *` 会因目录报错），再把文件名里的「轻库」替换为 ASCII 前缀 `qingku`，最后才上传——原因见上面的下载说明。

各平台打包步骤都拆成「编译 / 打包」两段，构建失败与打包失败能一眼区分；Linux 的 AppImage 需要外部工具，失败时回退为 deb + rpm，保证发版不会因为单一格式失败而中断。

> Windows 依赖 `ssh2` 时只在 Unix 上启用 `vendored-openssl`（见 `Cargo.toml` 的 `[target.'cfg(...)'.dependencies]`）：Windows 让它走 libssh2 自带的 WinCNG 后端，否则 `openssl-src` 会尝试从源码编译 OpenSSL，而 Windows runner 的 shell 里是 Git for Windows 的精简 Perl（缺 `Locale::Maketext::Simple`），必然失败。

> 没有开启 PR 触发的常规 CI：macOS runner 按 10 倍时长计费，个人账户额度紧张，因此只在发版时构建。

## 结构

```
src/            前端（无框架 JS 模块）
  main.js       Tab 管理器 + 启动
  tree.js       左侧连接/库/「表·查询」树
  grid.js       可编辑数据网格（通用表格渲染）
  filter.js     可视化筛选面板（条件 -> WHERE SQL）
  sql-util.js   标识符/字面量转义工具
  sql-format.js SQL 语句切分 / 美化 / 简化（尊重字符串与注释，纯函数可测）
  sql-highlight.js  CodeMirror SQL 高亮（编辑器样式 + 静态 HTML 高亮）
  sql-view.js   共享 SQL 编辑器/只读查看器基础配置
  tabs-data.js  数据浏览/编辑页（含外键右键跳转）
  tabs-struct.js 表结构页（列/索引/外键/DDL）
  tabs-tables.js 库下表列表页
  tabs-queries.js 保存的查询列表页
  tabs-design.js 可视化表设计器（CREATE/ALTER 生成，纯函数可测）
  tabs-query.js SQL 查询页（CodeMirror 6，⌘⏎ 执行 / ⌘S 保存）
  conn.js       连接对话框
  store.js      前端全局状态
src-tauri/
  tauri.conf.json               主配置（前端入口、窗口、打包基础设置）
  tauri.{macos,windows,linux}.conf.json  各平台打包格式（与主配置合并）
  src/
    lib.rs      Tauri 入口 + 命令注册
    db.rs       全部 MySQL 能力（连接池、元数据、CRUD、SQL 执行、SSH 隧道、
                CSV/JSON/Excel 导出、SQL INSERT 导出、保存查询持久化）
tests/
  smoke.rs          Rust 集成测试（连 3307 测试实例）
  filter.test.mjs   筛选条件拼装单测
  sql-highlight.test.mjs  SQL 高亮单测
  sql-format.test.mjs     SQL 美化/简化/切分单测
  dom-refs.test.mjs  守卫测试：模板 data-act/data-ref 与代码绑定、
                     插件 API 导入是否一致（防「按钮 HTML 被删但绑定还在」）
  harness/          无头 UI 验证页（stub Tauri invoke）+ 无缓存静态服务
```

## 本地冒烟测试

覆盖：`split_statements_basic`（SQL 拆分）、`foreign_key_metadata`（外键正/反向元数据）、`export_inserts_roundtrip`（INSERT 导出→回灌→数据一致）、`ssh_tunnel_e2e`（SSH 隧道真查 MySQL，需先启动 `tests/ssh-mock-server.py`，未启动自动跳过）、`full_crud_chain`（连接/元数据/分页/UPDATE/INSERT/DELETE）。

SSH 隧道测试的 mock 服务器：

```bash
/Users/lvruifeng/.workbuddy/binaries/python/envs/default/bin/python3 tests/ssh-mock-server.py 2222 &
# 监听 127.0.0.1:2222（账号 tunnel/test123），转发到 127.0.0.1:3307
```

> 测试数据里 `orders.user_id` 有指向 `users.id` 的外键（CASCADE），外键测试依赖它：
> ```sql
> ALTER TABLE orders ADD CONSTRAINT fk_orders_user
>   FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE ON UPDATE CASCADE;
> ```

`tests/smoke.rs` 连接本机 3307 测试实例（`~/.mysql-studio-test`）执行完整链路测试：

```bash
# 启动测试实例（root 无密码，端口 3307）
/usr/local/mysql/bin/mysqld --datadir=$HOME/.mysql-studio-test/data --port=3307 --mysqlx=OFF &
cd src-tauri && cargo test --test smoke
```
