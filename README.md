# 轻库 · MySQL 客户端 (mysql-studio-tauri)

基于 **Tauri 2 + Rust(mysql crate) + 原生 JS** 的 macOS 轻量 MySQL 客户端，类似 Navicat 的核心功能子集。

## 功能

- **连接管理**：多连接保存（本机 JSON 持久化）、测试连接、断开、编辑；支持 **SSH 隧道**（密码或私钥认证，经跳板机访问内网库；连接时自动建隧道、断开时关闭，测试连接也会先验证 SSH 可达）
- **对象浏览**：连接 → 数据库 →「表 / 查询」两级树；树交互为 Finder 风格——单击选中、双击展开/折叠、点箭头立即切换；数据库节点右键菜单（打开表列表 / 打开查询列表 / 新建表 / 新建查询 / 刷新 / 展开 / 复制库名），全局搜索筛选
- **表列表页**：点击库下的「表」打开，展示该库全部表/视图（类型、行数、引擎、注释、大小），支持搜索筛选、双击打开数据、右键打开结构页
- **保存的查询**：点击库下的「查询」打开列表页，可新建 / 重命名 / 删除 / 双击打开；查询页 ⌘S 或「保存」按钮命名保存（再次 ⌘S 覆盖更新、「另存为」存副本）；SQL 预览带语法高亮，保存后切回列表自动刷新
- **数据浏览与编辑**：分页浏览、列排序、WHERE 筛选；双击单元格直接 UPDATE（主键定位、NULL 支持、编辑确认可关）；新增行、勾选删除；无主键表自动只读
- **导出**：数据页可导出 CSV 或 **SQL INSERT 脚本**（默认导全表，带筛选条件时只导筛选结果；每 100 行一条多值 INSERT；中文/NULL/引号/二进制均正确转义，冒烟测试含「导出→回灌→数据一致」验证）
- **外键跳转**：数据页单元格右键，可跳到父表对应记录 / 子表关联记录（自动拼多列外键的 AND 条件），也可「仅显示该值」；跳转复用已有标签页，不会每次都开新页
- **可视化筛选器**：工具栏「🔍 筛选器」，多条件 AND/OR 组合，支持 `= ≠ > < ≥ ≤、LIKE、IN、BETWEEN、IS (NOT) NULL`，实时预览生成的 SQL，改动可自动应用；也保留手写 WHERE 输入框
- **表结构**：列 / 索引 / **外键** / DDL 四个子页；外键页同时展示「本表指向其他表」和「其他表指向本表」（反向引用），带约束名、列、ON UPDATE/DELETE 规则，点击父/子表可直接跳到其数据页
- **可视化表设计器**：表列表右键「设计表」、结构页「✏ 设计」、库右键/表列表「＋ 新建表」进入。图形化编辑列（名/类型/可空/主键/自增/默认值/注释，支持上下移排序）、索引（唯一/方法）、外键（引用与 ON DELETE/UPDATE 规则）；底部实时生成 SQL 预览，改表按 diff 生成最小 ALTER（ADD/MODIFY/CHANGE/DROP COLUMN、主键迁移、索引与外键增删改），执行前确认框列出删列/删主键等危险操作；主键列自动强制 NOT NULL。建表/改表逻辑为纯函数并有 15 项单测 + 真库执行验证
- **SQL 高亮**：查询编辑器、结果区 SQL、DDL 子页、保存查询列表共用同一套 CodeMirror SQL 高亮（关键字/字符串/数字/注释着色；DDL 为只读查看器）
- **查询结果右键**：复制值 / 复制整行（TSV）/ 复制列名 / 复制整行为 JSON

## 开发

```bash
npm install          # 前端依赖
npm run build        # esbuild 打包前端到 dist/
cd src-tauri && cargo build
cd .. && npx tauri dev      # 运行（直接使用 dist 静态资源）
npx tauri build             # 打包 .app / .dmg
```

> 前端构建用 esbuild（`build.mjs`）而非 vite——本机内存受限环境下 vite 会被 OOM 杀掉。
> crates.io 走 rsproxy 镜像（`src-tauri/.cargo/config.toml`，仅项目级生效）。

前端逻辑（筛选条件拼装、SQL 高亮输出、建表/改表 DDL 生成）是纯函数，有独立单测：

```bash
npm test        # filter / sql-highlight / design 三套测试
```

UI 交互可用无头浏览器验证：`tests/harness/index.html` 是 stub 掉 Tauri invoke 的验证页（mock 数据），启动 `python3 tests/harness/serve.py 8899` 后打开 `http://127.0.0.1:8899/tests/harness/index.html`。注意必须用 `serve.py`（发送 no-store 头），并配合页面里的时间戳加载器，否则浏览器会缓存旧的 `dist/assets/app.js`，误以为改动没生效。

## 结构

```
src/            前端（无框架 JS 模块）
  main.js       Tab 管理器 + 启动
  tree.js       左侧连接/库/「表·查询」树
  grid.js       可编辑数据网格（通用表格渲染）
  filter.js     可视化筛选面板（条件 -> WHERE SQL）
  sql-util.js   标识符/字面量转义工具
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
src-tauri/src/
  lib.rs        Tauri 入口 + 命令注册
  db.rs         全部 MySQL 能力（连接池、元数据、CRUD、SQL 执行、CSV 导出、保存查询持久化）
tests/
  smoke.rs          Rust 集成测试（连 3307 测试实例）
  filter.test.mjs   筛选条件拼装单测
  sql-highlight.test.mjs  SQL 高亮单测
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
