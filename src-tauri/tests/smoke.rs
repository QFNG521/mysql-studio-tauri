// 集成冒烟测试：直连本机 3307 测试实例，验证 db.rs 核心链路。
// 运行前需启动测试 MySQL：
//   /usr/local/mysql/bin/mysqld --datadir=$HOME/.mysql-studio-test/data --port=3307 --socket=/tmp/mysql-studio-test.sock --mysqlx=OFF &

use mysql::prelude::Queryable;
use mysql_studio_tauri_lib::db::*;
use std::path::Path;

fn cfg() -> ConnConfig {
    ConnConfig {
        id: "smoke".into(),
        name: "smoke".into(),
        host: "127.0.0.1".into(),
        port: 3307,
        user: "root".into(),
        password: String::new(),
        database: Some("testdb".into()),
        timeout_secs: 5,
        ssh_enabled: false,
        ssh_host: String::new(),
        ssh_port: 0,
        ssh_user: String::new(),
        ssh_password: String::new(),
        ssh_key_path: None,
        ssl_enabled: false,
        ssl_ca: None,
        ssl_cert: None,
        ssl_key: None,
    }
}

#[test]
fn split_statements_basic() {
    let sql = "SELECT 1; SELECT 'a;b' FROM t WHERE c = \"x;y\"; -- comment\nUPDATE t SET a=1;\n/* block ; */ INSERT INTO t VALUES ('it''s'); # hash\n";
    let out = split_statements(sql);
    assert_eq!(out.len(), 4, "got: {out:?}");
    assert_eq!(out[0], "SELECT 1");
    assert_eq!(out[1], "SELECT 'a;b' FROM t WHERE c = \"x;y\"");
    assert_eq!(out[3], "INSERT INTO t VALUES ('it''s')");
    // 块注释内的分号不分割（仍在同一条语句内）
    let out2 = split_statements("UPDATE t SET a=1 /* x ; y */ WHERE b=2");
    assert_eq!(out2.len(), 1);
}

#[test]
fn foreign_key_metadata() {
    let opts = build_opts(&cfg());
    let pool = mysql::Pool::new(opts).unwrap();
    let mut conn = pool.get_conn().unwrap();
    conn.query_drop("SET NAMES utf8mb4").unwrap();

    // orders.user_id -> users.id (ON DELETE/UPDATE CASCADE)
    let fks = load_foreign_keys(&mut conn, "testdb", "orders").expect("load fk");
    assert_eq!(fks.len(), 1, "orders 应有 1 条外键, got {fks:?}");
    let fk = &fks[0];
    assert_eq!(fk.name, "fk_orders_user");
    assert_eq!(fk.column, "user_id");
    assert_eq!(fk.ref_db, "testdb");
    assert_eq!(fk.ref_table, "users");
    assert_eq!(fk.ref_column, "id");
    assert_eq!(fk.on_delete, "CASCADE");
    assert_eq!(fk.on_update, "CASCADE");

    // 反向：users 被 orders 引用
    let inc = load_referenced_by(&mut conn, "testdb", "users").expect("load ref");
    assert!(inc.iter().any(|f| f.ref_table == "orders"
        && f.column == "user_id"
        && f.ref_column == "id"
        && f.name == "fk_orders_user"), "users 应被 orders 引用, got {inc:?}");

    // 无外键的表返回空数组而不是报错
    let none = load_foreign_keys(&mut conn, "testdb", "no_pk_table").expect("load fk");
    assert!(none.is_empty(), "no_pk_table 不应有外键");

    println!("FK OK · {} -> {}.{}", fk.column, fk.ref_table, fk.ref_column);
}

#[test]
fn export_inserts_roundtrip() {
    let opts = build_opts(&cfg());
    let pool = mysql::Pool::new(opts).unwrap();
    let mut conn = pool.get_conn().unwrap();
    conn.query_drop("SET NAMES utf8mb4").unwrap();

    // 导出 users 表（含中文、NULL、引号数据）为 INSERT 脚本
    let mut buf: Vec<u8> = Vec::new();
    let n = dump_inserts(&mut buf, &mut conn, "testdb", "users", None).expect("dump");
    assert_eq!(n, 5, "users 应导出 5 行, got {n}");
    let restored_sql = String::from_utf8(buf).expect("utf8");

    // 头部与批量 INSERT 结构
    assert!(restored_sql.contains("SET NAMES utf8mb4;"), "缺 SET NAMES: {restored_sql}");
    assert!(restored_sql.contains("INSERT INTO `testdb`.`users` ("), "缺 INSERT 头: {restored_sql}");

    // 中文正确、NULL 字面量、引号转义
    assert!(restored_sql.contains("张三"), "中文应为原文而非乱码: {restored_sql}");
    assert!(restored_sql.contains(",NULL,"), "NULL 应输出为 NULL 字面量: {restored_sql}");

    // 带筛选导出：只导 1 行
    let mut buf2: Vec<u8> = Vec::new();
    let n2 = dump_inserts(&mut buf2, &mut conn, "testdb", "users", Some("`id` = 1")).expect("dump2");
    assert_eq!(n2, 1, "带 WHERE 应只导出 1 行, got {n2}");

    // 回灌验证：建临时表，把脚本里的表名替换后执行（导出脚本写的是原表名，符合真实场景），
    // 行数与内容一致后清理
    conn.query_drop("DROP TABLE IF EXISTS testdb.users_restore").unwrap();
    conn.query_drop("CREATE TABLE testdb.users_restore LIKE testdb.users").unwrap();
    let restore_sql = restored_sql.replace("`testdb`.`users`", "`testdb`.`users_restore`");
    for stmt in split_statements(&restore_sql) {
        if stmt.starts_with("--") || stmt.starts_with("SET NAMES") {
            continue;
        }
        conn.query_drop(stmt).expect("执行导出的 INSERT");
    }
    let cnt: u64 = conn
        .query_first("SELECT COUNT(*) FROM testdb.users_restore")
        .unwrap()
        .unwrap();
    assert_eq!(cnt, 5, "回灌后行数应为 5, got {cnt}");
    let name0: Option<(String,)> = conn
        .query_first("SELECT name FROM testdb.users_restore ORDER BY id LIMIT 1")
        .unwrap();
    assert_eq!(name0.unwrap().0, "张三", "回灌后中文应保持正确");
    conn.query_drop("DROP TABLE testdb.users_restore").unwrap();

    println!("EXPORT OK · {n} rows dumped & restored");
}

#[test]
fn ssh_tunnel_e2e() {
    // mock sshd（tests/ssh-mock-server.py）没启动时跳过
    let probe: std::net::SocketAddr = "127.0.0.1:2222".parse().unwrap();
    if std::net::TcpStream::connect_timeout(&probe, std::time::Duration::from_secs(1)).is_err() {
        eprintln!("SKIP: mock sshd(2222) 未启动");
        return;
    }

    let mut c = cfg();
    c.ssh_enabled = true;
    c.ssh_host = "127.0.0.1".into();
    c.ssh_port = 2222;
    c.ssh_user = "tunnel".into();
    c.ssh_password = "test123".into();

    // 隧道建立并自动验证认证/转发
    let tunnel = start_ssh_tunnel(&c).expect("start tunnel");
    let mut eff = c.clone();
    eff.host = "127.0.0.1".into();
    eff.port = tunnel.local_port;

    // 经隧道完成一次真实 MySQL 查询
    let opts = build_opts(&eff);
    let pool = mysql::Pool::new(opts).expect("pool via tunnel");
    let mut conn = pool.get_conn().expect("conn via tunnel");
    conn.query_drop("SET NAMES utf8mb4").unwrap();
    let val: Option<(String,)> = conn
        .query_first("SELECT name FROM users ORDER BY id LIMIT 1")
        .unwrap();
    assert_eq!(val.unwrap().0, "张三", "经隧道查询中文数据应正确");

    // 二次查询（验证通道复用/多条请求稳定）
    let cnt: u64 = conn
        .query_first("SELECT COUNT(*) FROM users")
        .unwrap()
        .unwrap();
    assert_eq!(cnt, 5);

    // 错误密码应被拒绝
    let mut bad = c.clone();
    bad.ssh_password = "wrong".into();
    assert!(start_ssh_tunnel(&bad).is_err(), "错误 SSH 密码应失败");

    drop(tunnel); // 关闭隧道
    println!("SSH TUNNEL OK · mysql over ssh tunnel verified");
}

#[test]
fn ssl_connection() {
    // 测试实例（--initialize-insecure 自动生成自签名证书）没开 SSL 时跳过
    let data_dir = format!(
        "{}/.mysql-studio-test/data",
        std::env::var("HOME").unwrap_or_default()
    );
    let ca = format!("{data_dir}/ca.pem");
    if !Path::new(&ca).exists() {
        eprintln!("SKIP: 未找到测试 CA 证书 ({ca})");
        return;
    }

    // 1) 带 CA 验证的 SSL 连接
    let mut c = cfg();
    c.ssl_enabled = true;
    c.ssl_ca = Some(ca);
    let pool = mysql::Pool::new(build_opts(&c)).expect("SSL(verify) 连接失败");
    let mut conn = pool.get_conn().expect("SSL(verify) 会话失败");
    let cipher: Option<(String, String)> = conn.query_first("SHOW STATUS LIKE 'Ssl_cipher'").unwrap();
    let cipher = cipher.expect("Ssl_cipher 行").1;
    assert!(!cipher.is_empty(), "应使用 TLS 加密通道, Ssl_cipher='{cipher}'");

    // 2) 无 CA（仅加密不验证）也应能连上自签名实例
    let mut c2 = cfg();
    c2.ssl_enabled = true;
    let pool2 = mysql::Pool::new(build_opts(&c2)).expect("SSL(仅加密) 连接失败");
    let mut conn2 = pool2.get_conn().unwrap();
    let cipher2: Option<(String, String)> = conn2.query_first("SHOW STATUS LIKE 'Ssl_cipher'").unwrap();
    assert!(!cipher2.expect("row").1.is_empty(), "无 CA 时也应有加密通道");

    // 3) 双向认证（客户端证书 + 私钥）
    let client_cert = format!("{data_dir}/client-cert.pem");
    let client_key = format!("{data_dir}/client-key.pem");
    if Path::new(&client_cert).exists() && Path::new(&client_key).exists() {
        let mut c3 = c.clone();
        c3.ssl_cert = Some(client_cert);
        c3.ssl_key = Some(client_key);
        let pool3 = mysql::Pool::new(build_opts(&c3)).expect("SSL(双向认证) 连接失败");
        let _ = pool3.get_conn().expect("双向认证会话失败");
    }

    // 4) 中文经 TLS 通道不乱码
    conn.query_drop("SET NAMES utf8mb4").unwrap();
    let name: Option<(String,)> = conn
        .query_first("SELECT name FROM users ORDER BY id LIMIT 1")
        .unwrap();
    assert_eq!(name.unwrap().0, "张三");

    println!("SSL OK · cipher={cipher}");
}

#[test]
fn full_crud_chain() {
    let c = cfg();

    // 连接
    let (version, dbs) = connect_impl(&c).expect("connect");
    assert!(!version.is_empty());
    assert!(dbs.iter().any(|d| d.name == "testdb"));

    // 表列表
    let opts = build_opts(&c);
    let pool = mysql::Pool::new(opts).unwrap();
    let mut conn = pool.get_conn().unwrap();
    // 与应用行为一致：会话必须 utf8mb4，否则中文按 latin1 返回会乱码
    conn.query_drop("SET NAMES utf8mb4").unwrap();
    let cs: Vec<(String, String)> = conn
        .query("SHOW VARIABLES LIKE 'character_set_connection'")
        .unwrap();
    assert_eq!(cs[0].1, "utf8mb4", "连接字符集应为 utf8mb4");
    conn.query_drop("USE testdb").unwrap();

    let tables: Vec<String> = conn
        .query("SHOW TABLES")
        .unwrap();
    assert!(tables.contains(&"users".to_string()));

    // 元数据（通过原生查询验证与 db.rs 相同的 SQL）
    let pk: Option<(String,)> = conn
        .exec_first(
            "SELECT COLUMN_NAME FROM information_schema.COLUMNS \
             WHERE TABLE_SCHEMA='testdb' AND TABLE_NAME='users' AND COLUMN_KEY='PRI'",
            (),
        )
        .unwrap();
    assert_eq!(pk.map(|p| p.0), Some("id".to_string()));

    // 分页数据
    {
        let mut res = conn
            .query_iter("SELECT * FROM `testdb`.`users` ORDER BY `id` ASC LIMIT 0, 200")
            .unwrap();
        let cols = res.columns();
        assert_eq!(cols.as_ref().len(), 7);
        let rows: Vec<mysql::Row> = res.by_ref().collect::<Result<_, _>>().unwrap();
        assert_eq!(rows.len(), 5);
        let name0: Option<String> = rows[0].get("name");
        assert_eq!(name0.as_deref(), Some("张三"));
        let null_age: Option<mysql::Value> = rows[3].get("age");
        assert!(matches!(null_age, Some(mysql::Value::NULL)), "赵六 age 应为 NULL");
    }

    // UPDATE / INSERT / DELETE
    conn.exec_drop(
        "UPDATE `testdb`.`users` SET `note` = ? WHERE `id` = ? LIMIT 1",
        ("冒烟更新", 1u64),
    )
    .unwrap();
    let v: Option<(String,)> = conn
        .exec_first("SELECT note FROM users WHERE id=1", ())
        .unwrap();
    assert_eq!(v.unwrap().0, "冒烟更新");

    conn.exec_drop(
        "INSERT INTO `testdb`.`users` (`name`, `age`) VALUES (?, ?)",
        ("冒烟用户", Option::<i32>::None),
    )
    .unwrap();
    let cnt: u64 = conn
        .query_first("SELECT COUNT(*) FROM users WHERE name='冒烟用户'")
        .unwrap()
        .unwrap();
    assert_eq!(cnt, 1);
    conn.exec_drop("DELETE FROM users WHERE name='冒烟用户'", ()).unwrap();

    // SQL 字符串内分号不被误切
    let stmts = split_statements("SELECT '张三;test' AS x");
    assert_eq!(stmts.len(), 1);

    println!("SMOKE OK · server={version}");
}
